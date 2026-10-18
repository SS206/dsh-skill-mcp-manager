// Shared v2 test harness.
//
// v2 rows live in the profile's patch layers and the plugin-private state is
// `agents.<profile>.json` — there is no registry. This harness builds that
// fixture inside a test-owned temp dir, points DSH_HOME at it BEFORE importing
// the plugin (the module-level DSH_HOME is read at import time), boots `apply`
// against a mock ctx, and hands back everything a smoke test drives: registered
// tools, HTTP routes, commands, the pre-step listener and the fixture readers.
//
// Row spec:
//   { id, serverName?, config, disabled?, proxied?, tools?, snapshot?, notes? }
//     config    — MCP client config (serverName is derived when omitted)
//     disabled  — row-level `disabled: true` in the row's own text
//     proxied   — write the user-layer `- id: X` + `disabled: true` override
//                 AND an agent-state record, i.e. the on-demand tier
//     tools     — per-tool switches for that record ({ block: false })
//     snapshot  — cached snapshot for that record

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";

/** One `- insert:` block holding the given rows. */
function insertBlock(rows) {
  return stringify([{
    insert: rows.map((row) => ({
      id: row.id,
      name: "@deepseek-ai/dsh-mcp-client",
      config: { serverName: row.serverName ?? row.id.replace(/^mcp-/, ""), ...row.config },
      ...(row.disabled === true ? { disabled: true } : {}),
    })),
  }]);
}

function overrideItem(id, disabled = true) {
  return `- id: ${JSON.stringify(id)}\n  disabled: ${disabled ? "true" : "false"}`;
}

/** Build the profile patch text for a row spec list. */
export function patchFor(rows, { preamble = "", overrides = [] } = {}) {
  const parts = [];
  if (preamble.trim() !== "") parts.push(preamble.replace(/\s+$/, ""));
  const insertRows = rows.filter((row) => row.block !== false);
  if (insertRows.length > 0) parts.push(insertBlock(insertRows).replace(/\s+$/, ""));
  for (const row of rows) {
    if (row.proxied === true) parts.push(overrideItem(row.id, true));
  }
  for (const item of overrides) parts.push(overrideItem(item.id, item.disabled !== false));
  return parts.join("\n\n") + "\n";
}

/** Build the agent-state document for a row spec list. */
export function agentsFor(rows, { notes = {} } = {}) {
  const state = { version: 1, rows: {}, snapshots: {}, notes: {} };
  for (const row of rows) {
    if (row.proxied === true) state.rows[row.id] = { tools: row.tools ?? {} };
    if (row.snapshot !== undefined) state.snapshots[row.id] = row.snapshot;
    if (row.notes !== undefined) state.notes[row.id] = row.notes;
  }
  for (const [id, text] of Object.entries(notes)) state.notes[id] = text;
  return state;
}

/**
 * Boot the plugin against a fixture.
 * @param {object} opts
 * @returns the handles described in the file header.
 */
export async function bootPlugin(opts = {}) {
  const {
    tmp,
    profile = "__test__",
    rows = [],
    preamble = "",
    overrides = [],
    rawPatch = undefined,
    rawAgents = undefined,
    rawRegistry = undefined,
    agents = undefined,
    settings = {},
    bundles = [],
    skills = undefined,
    withWebServer = true,
    withCommands = true,
    presets = undefined,
    services = {},
    applyConfig = {},
  } = opts;
  if (typeof tmp !== "string" || tmp === "") throw new Error("bootPlugin needs a tmp dir");

  const dataDir = join(tmp, "data");
  const profileDir = join(tmp, "profiles", profile);
  const serverPath = join(tmp, "server.mjs");
  await rm(tmp, { recursive: true, force: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });

  await writeFile(
    join(profileDir, "cordis.patch.yml"),
    rawPatch !== undefined ? rawPatch : patchFor(rows, { preamble, overrides }),
    "utf8",
  );
  await writeFile(join(profileDir, "cordis.yml"), "[]\n", "utf8");

  if (rawAgents !== undefined) {
    await writeFile(join(dataDir, `agents.${profile}.json`), `${JSON.stringify(rawAgents, null, 2)}\n`, "utf8");
  }
  if (rawRegistry !== undefined) {
    await writeFile(join(dataDir, `registry.${profile}.json`), `${JSON.stringify(rawRegistry, null, 2)}\n`, "utf8");
  }
  const agentState = rawAgents ?? agents ?? agentsFor(rows);
  if (rawAgents === undefined
    && (Object.keys(agentState.rows).length > 0 || Object.keys(agentState.snapshots).length > 0 || Object.keys(agentState.notes).length > 0)) {
    await writeFile(join(dataDir, `agents.${profile}.json`), `${JSON.stringify(agentState, null, 2)}\n`, "utf8");
  }
  if (Object.keys(settings).length > 0) {
    await writeFile(join(dataDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }

  if (bundles.length > 0) {
    const names = [];
    for (const bundle of bundles) {
      names.push(bundle.name);
      const dir = join(profileDir, "node_modules", bundle.name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "package.json"), `${JSON.stringify({ name: bundle.name, version: "1.0.0", private: true, dsh: { bundle: { patch: "./cordis.patch.yml" } } }, null, 2)}\n`, "utf8");
      await writeFile(join(dir, "cordis.patch.yml"), bundle.patch ?? "[]\n", "utf8");
    }
    await writeFile(join(profileDir, "package.json"), `${JSON.stringify({ name: `dsh-profile-${profile}`, private: true, dsh: { profile: { bundles: names } } }, null, 2)}\n`, "utf8");
  }

  // The plugin reads DSH_HOME at module scope — set it before the import.
  process.env.DSH_HOME = tmp;
  const lib = await import("../../lib/index.js");

  const registrations = [];
  const routes = [];
  const commands = [];
  const effects = [];
  let preStep;

  const toolsService = {
    register(definition) {
      const record = { definition, active: true };
      registrations.push(record);
      return () => { record.active = false; };
    },
  };
  const skillsService = skills ?? { registerProvider() { return () => {}; } };

  const ctx = {
    tools: toolsService,
    skills: skillsService,
    on(event, handler) {
      if (event === "agent/pre-step") preStep = handler;
      return () => {};
    },
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === "function") effects.push(disposer);
      return () => {};
    },
    get(name) {
      if (name === "webServer" && withWebServer) {
        return { register(route) { routes.push(route); return () => {}; } };
      }
      if (name === "commands" && withCommands) {
        return { register(definition) { commands.push(definition); return () => {}; } };
      }
      if (name === "agentPresets" && presets !== undefined) return presets;
      if (Object.prototype.hasOwnProperty.call(services, name)) return services[name];
      return undefined;
    },
    logger: { warn() {}, error() {}, info() {} },
  };

  await lib.apply(ctx, { dataDir, profile, trialTimeoutMs: 5000, toolCallTimeoutMs: 5000, ...applyConfig });

  /** The live definition of one registered model-facing tool. */
  function tool(name) {
    return [...registrations].reverse().find((record) => record.active && record.definition.name === name)?.definition;
  }

  /**
   * An agent whose tools service is the plugin's mock host. Per-session
   * disposers land in `sessionEffects` so a test can drop one session's
   * runtime (the plugin scopes its instances to `agent.ctx.effect`).
   */
  function makeAgent(extra = {}) {
    const sessionEffects = [];
    return {
      ctx: {
        tools: toolsService,
        effect(fn) {
          const disposer = fn();
          if (typeof disposer === "function") sessionEffects.push(disposer);
          return () => {};
        },
      },
      session: { surface: { nodes: [] }, events: [] },
      sessionEffects,
      ...extra,
    };
  }

  function routeByPath(path) {
    return routes.find((route) => route.path === path);
  }

  /** Drive one registered route with a fake loopback request. */
  async function callRoute(path, method, body, { headers = {}, url = path } = {}) {
    const route = routeByPath(path);
    if (route === undefined) throw new Error(`route ${path} is not registered`);
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
    let index = 0;
    const request = {
      method,
      url,
      headers: { origin: "http://127.0.0.1:7404", host: "127.0.0.1:7404", ...headers },
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return index < chunks.length ? { value: chunks[index++], done: false } : { done: true };
          },
        };
      },
    };
    const response = { status: 0, body: "" };
    response.writeHead = (status) => { response.status = status; };
    response.end = (chunk) => { response.body = chunk; };
    await route.handler(request, response);
    let json;
    try { json = response.body === "" ? undefined : JSON.parse(response.body); } catch { json = undefined; }
    return { status: response.status, json, body: response.body };
  }

  const readPatch = async () => await readFile(join(profileDir, "cordis.patch.yml"), "utf8");
  const readAgents = async (name = profile) => {
    try {
      return JSON.parse(await readFile(join(dataDir, `agents.${name}.json`), "utf8"));
    } catch (error) {
      if (error && error.code === "ENOENT") return null;
      throw error;
    }
  };
  const readSettings = async () => {
    try {
      return JSON.parse(await readFile(join(dataDir, "settings.json"), "utf8"));
    } catch (error) {
      if (error && error.code === "ENOENT") return null;
      throw error;
    }
  };

  async function cleanup() {
    for (const dispose of effects.reverse()) {
      try { await dispose(); } catch { /* ignore */ }
    }
    await rm(tmp, { recursive: true, force: true });
  }

  return {
    lib, ctx, tmp, dataDir, profileDir, serverPath, profile,
    registrations, routes, commands, effects, get preStep() { return preStep; },
    tool, makeAgent, callRoute, routeByPath, readPatch, readAgents, readSettings, cleanup,
  };
}

/** Register a trivial stdio MCP server file for a test (path in the temp dir). */
export async function writeProbeServer(path, body) {
  await writeFile(path, body, "utf8");
  return path;
}

export { insertBlock, overrideItem };
