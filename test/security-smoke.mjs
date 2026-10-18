// Security and correctness changes: child env scrub, $NAME expansion, browser
// host guard, /mcp prepare-uninstall, local-command approval, eager mount
// skipping, connect-failure downgrade, backup retention, reported version.

import { mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { readFileSync } from "node:fs";

const tmp = join(process.cwd(), ".test-data", "security-smoke-" + process.pid);
const home = join(tmp, "home");
const failed = [];
await rm(tmp, { recursive: true, force: true });
await mkdir(join(home, "profiles", "__test__"), { recursive: true });
await writeFile(join(home, "profiles", "__test__", "cordis.patch.yml"), "[]\n", "utf8");
// The plugin resolves DSH_HOME at import time and writes the booted profile's
// patch: redirect it before the import so the run never touches the real home.
process.env.DSH_HOME = home;
const { apply, PLUGIN_VERSION, pruneBackups } = await import("../lib/index.js");
const { scrubParentEnv, resolveExplicitEnv, childEnv } = await import("../lib/child-env.js");
const { hostPermitted, requestPermitted } = await import("../lib/ui.js");

function check(condition, message) {
  if (!condition) failed.push(message);
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
check(PLUGIN_VERSION === pkg.version, `reported version ${PLUGIN_VERSION} !== package ${pkg.version}`);

const parent = {
  PATH: "C:\\Windows",
  API_KEY: "secret-key",
  password: "secret-pass",
  MY_TOKEN: "secret-token",
  DSH_HOME: "C:\\Users\\me\\.dsh",
  dsh_profile: "desktop",
  PLAIN: "kept",
};
const scrubbed = scrubParentEnv(parent);
check(scrubbed.PLAIN === "kept" && scrubbed.PATH === "C:\\Windows", "non-secret env was dropped");
check(scrubbed.API_KEY === undefined && scrubbed.password === undefined && scrubbed.MY_TOKEN === undefined, "credential-shaped env was inherited");
check(scrubbed.DSH_HOME === undefined && scrubbed.dsh_profile === undefined, "DSH_ env was inherited");

const explicit = resolveExplicitEnv({
  TOKEN: "$MY_TOKEN",
  MISSING: "$NOT_SET",
  LITERAL: "prefix-$MY_TOKEN",
  BRACES: "${MY_TOKEN}",
  TEXT: "plain",
}, { MY_TOKEN: "real" });
check(explicit.TOKEN === "real", `$NAME was not expanded, got ${explicit.TOKEN}`);
check(explicit.MISSING === "", `missing $NAME should be empty, got ${JSON.stringify(explicit.MISSING)}`);
check(explicit.LITERAL === "prefix-$MY_TOKEN" && explicit.BRACES === "${MY_TOKEN}", "partial references were expanded");
check(explicit.TEXT === "plain", "literal env changed");

const merged = await childEnv({ API_KEY: "$MY_TOKEN", NOTE: "keep me" }, parent);
check(merged.API_KEY === "secret-token", "explicit reference did not override the scrub");
check(merged.NOTE === "keep me", "explicit literal missing");
check(merged.password === undefined && merged.DSH_HOME === undefined, "scrubbed names came back without an explicit value");
check(merged.PLAIN === "kept", "scrubbed base was not inherited");

check(hostPermitted("127.0.0.1:7404", []), "loopback IP was rejected");
check(hostPermitted("[::1]:7404", []), "IPv6 loopback was rejected");
check(hostPermitted("localhost:7404", []), "localhost was rejected");
check(hostPermitted(`${hostname()}:7404`, []), "machine hostname was rejected");
check(!hostPermitted("files.example:7404", []), "LAN hostname was allowed by default");
check(hostPermitted("Files.Example:7404", ["files.example"]), "allowlist match was case-sensitive");

// Request gate. DSH Desktop's proxy strips Origin and Host before forwarding,
// so an absent Origin must be allowed; a present-but-mismatched one must not.
check(requestPermitted({ headers: {} }, []), "a stripped-proxy request was refused");
check(requestPermitted({ headers: { host: "127.0.0.1:7404" } }, []), "an Origin-less loopback request was refused");
check(
  requestPermitted({ headers: { origin: "http://127.0.0.1:7404", host: "127.0.0.1:7404" } }, []),
  "a same-origin request was refused",
);
check(
  !requestPermitted({ headers: { origin: "http://evil.example:7404", host: "127.0.0.1:7404" } }, []),
  "a cross-origin request was allowed",
);
check(!requestPermitted({ headers: { origin: "null", host: "127.0.0.1:7404" } }, []), "Origin: null was allowed");
check(!requestPermitted({ headers: { origin: "", host: "127.0.0.1:7404" } }, []), "an empty Origin was allowed");
check(!requestPermitted({ headers: { host: "evil.example:7404" } }, []), "a non-loopback Host was allowed");
check(
  !requestPermitted(
    { headers: { origin: "http://127.0.0.1:7404", host: "127.0.0.1:7404", "sec-fetch-site": "cross-site" } },
    [],
  ),
  "a cross-site request was allowed",
);
check(
  requestPermitted({ headers: { origin: "http://files.example:7404", host: "files.example:7404" } }, ["files.example"]),
  "a declared authority was refused",
);

const backupDir = join(tmp, "backups");
await mkdir(backupDir, { recursive: true });
for (let i = 1; i <= 7; i += 1) await writeFile(join(backupDir, `cordis.patch.yml.bak-${i}`), String(i), "utf8");
await writeFile(join(backupDir, "cordis.patch.yml"), "live", "utf8");
await writeFile(join(backupDir, "notes.bak-1"), "other", "utf8");
await pruneBackups(backupDir, "cordis.patch.yml.bak-");
const left = (await readdir(backupDir)).filter((name) => name.startsWith("cordis.patch.yml.bak-")).sort();
check(left.join(",") === "cordis.patch.yml.bak-3,cordis.patch.yml.bak-4,cordis.patch.yml.bak-5,cordis.patch.yml.bak-6,cordis.patch.yml.bak-7", `backup prune left ${left.join(",")}`);
check((await readdir(backupDir)).includes("notes.bak-1"), "unrelated backup was deleted");
check((await readdir(backupDir)).includes("cordis.patch.yml"), "live patch was deleted");

function makeRes() {
  const res = { status: 0, body: "" };
  res.writeHead = (status) => { res.status = status; };
  res.end = (body) => { res.body = body ?? ""; };
  return res;
}

function makeReq(method, url, headers, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  let index = 0;
  return {
    method,
    url,
    headers,
    [Symbol.asyncIterator]() {
      return { async next() { return index < chunks.length ? { value: chunks[index++], done: false } : { done: true }; } };
    },
  };
}

async function callRoute(routes, path, method, headers, body) {
  const route = routes.find((item) => item.path === path);
  const res = makeRes();
  await route.handler(makeReq(method, path, headers, body), res);
  return { status: res.status, body: res.body ? JSON.parse(res.body) : {} };
}

const serverPath = join(tmp, "server.mjs");
await writeFile(serverPath, `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const server = new Server({ name: "security-smoke", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "ping", description: "ping", inputSchema: { type: "object", additionalProperties: false } }],
}));
server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "pong" }] }));
await server.connect(new StdioServerTransport());
`, "utf8");

const failPath = join(tmp, "fail.mjs");
const failLog = join(tmp, "fail.log");
await writeFile(failPath, `
import { appendFileSync } from "node:fs";
appendFileSync(process.argv[2], "x\\n");
process.exit(1);
`, "utf8");

function harness() {
  const routes = [];
  const commands = [];
  const effects = [];
  let preStep;
  const ctx = {
    tools: { register(definition) { return () => { definition.active = false; }; } },
    skills: { registerProvider() { return () => {}; } },
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
      if (name === "webServer") return { register(route) { routes.push(route); return () => {}; } };
      if (name === "commands") return { register(definition) { commands.push(definition); return () => {}; } };
      return undefined;
    },
    logger: { warn() {}, error() {}, info() {} },
  };
  return { ctx, routes, commands, effects, preStep: () => preStep };
}

async function dispose(effects) {
  for (const disposeEffect of effects.reverse()) await disposeEffect();
}

// Browser guard and /mcp command, against an empty registry.
{
  const dataDir = join(tmp, "guard");
  await mkdir(dataDir, { recursive: true });
  const { ctx, routes, commands, effects } = harness();
  await apply(ctx, { dataDir, profile: "__test__", importNativeMcp: false });
  const local = { origin: "http://127.0.0.1:7404", host: "127.0.0.1:7404" };
  const openGet = await callRoute(routes, "/skill-mcp-manager/mcp", "GET", local);
  check(openGet.status === 200, `local GET failed: ${openGet.status}`);
  const noOriginGet = await callRoute(routes, "/skill-mcp-manager/mcp", "GET", {});
  check(noOriginGet.status === 200, "non-browser GET was rejected");
  // The Desktop proxy's shape: no Origin, no Host. It must reach the handler
  // (400 = "no such entry"), never the old 403.
  const noOriginPost = await callRoute(routes, "/skill-mcp-manager/mcp/delete", "POST", {}, { name: "missing" });
  check(noOriginPost.status === 400, `Desktop-proxy POST never reached the handler: ${noOriginPost.status}`);
  const loopbackPost = await callRoute(routes, "/skill-mcp-manager/mcp/delete", "POST", { host: "127.0.0.1:7404" }, { name: "missing" });
  check(loopbackPost.status === 400, `Origin-less POST with a loopback Host was refused: ${loopbackPost.status}`);
  const nullOrigin = await callRoute(routes, "/skill-mcp-manager/mcp/delete", "POST", { origin: "null", host: "127.0.0.1:7404" }, { name: "missing" });
  check(nullOrigin.status === 403, "Origin: null was allowed");
  const crossSite = await callRoute(
    routes,
    "/skill-mcp-manager/mcp/delete",
    "POST",
    { origin: "http://127.0.0.1:7404", host: "127.0.0.1:7404", "sec-fetch-site": "cross-site" },
    { name: "missing" },
  );
  check(crossSite.status === 403, "a cross-site POST was allowed");
  const reboundRead = await callRoute(routes, "/skill-mcp-manager/mcp", "GET", { host: "evil.example:7404" });
  check(reboundRead.status === 403, "a non-loopback Host on a read was allowed");
  const evil = await callRoute(routes, "/skill-mcp-manager/mcp", "GET", { origin: "http://files.example:7404", host: "files.example:7404" });
  check(evil.status === 403, "DNS-rebound hostname was allowed");
  const saved = await callRoute(routes, "/skill-mcp-manager/settings", "POST", local, {
    localCommandApproval: "always-ask",
    lanHostAllowlist: ["files.example"],
  });
  check(saved.status === 200 && saved.body.localCommandApproval === "always-ask", `settings save failed: ${JSON.stringify(saved.body)}`);
  const allowed = await callRoute(routes, "/skill-mcp-manager/mcp", "GET", { origin: "http://files.example:7404", host: "files.example:7404" });
  check(allowed.status === 200, "allowlisted hostname was rejected");
  const blockedSave = await callRoute(routes, "/skill-mcp-manager/settings", "POST", {
    origin: "http://other.example:7404",
    host: "other.example:7404",
  }, { lanHostAllowlist: ["other.example"] });
  check(blockedSave.status === 403, "disallowed host added itself");
  const mcp = commands.find((command) => command.name === "mcp");
  const listed = await mcp.handler({ rawInput: "" });
  check(
    listed.kind === "success" && /No managed MCP servers/.test(listed.text),
    `bare /mcp did not list: ${listed.text}`,
  );
  const unknown = await mcp.handler({ rawInput: "nope" });
  check(unknown.kind === "error" && unknown.text.includes("prepare-uninstall"), `unknown /mcp did not explain usage: ${unknown.text}`);
  // v2 prepare-uninstall drops this plugin's overrides and agent state; with no
  // patch and no state it is a clean no-op instead of a read failure.
  const handed = await mcp.handler({ rawInput: "prepare-uninstall" });
  check(handed.kind === "success" && /Removed 0 override/.test(handed.text), `prepare-uninstall did not run: ${handed.text}`);
  await dispose(effects);
}

// Approval: read-only asks, and a rejection does not start or save the process.
{
  const dataDir = join(tmp, "approval-reject");
  await mkdir(dataDir, { recursive: true });
  const marker = join(tmp, "rejected-start.txt");
  const asks = [];
  const tools = [];
  const effects = [];
  const ctx = {
    tools: { register(definition) { tools.push(definition); return () => {}; } },
    skills: { registerProvider() { return () => {}; } },
    on() { return () => {}; },
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === "function") effects.push(disposer);
      return () => {};
    },
    get(name) {
      if (name === "sandboxPolicy") return { resolve() { return { mode: "read-only" }; } };
      if (name === "approval") return { async request(req) { asks.push(req); return "rejected"; } };
      return undefined;
    },
    logger: { warn() {}, error() {}, info() {} },
  };
  await apply(ctx, { dataDir, profile: "__test__", importNativeMcp: false, trialTimeoutMs: 3000 });
  const mcpRegister = tools.find((tool) => tool.name === "mcp_register");
  let error = "";
  try {
    await mcpRegister.execute({
      name: "local",
      transport: "stdio",
      command: process.execPath,
      args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran")`],
    }, { agent: { session: {} }, signal: new AbortController().signal });
  } catch (caught) {
    error = String(caught?.message ?? caught);
  }
  check(/not approved/.test(error), `rejection did not stop the register: ${error}`);
  check(asks.length === 1 && asks[0].reason.includes(process.execPath), "approval reason did not show the program");
  check(asks[0].reason.includes("再次启动"), "approval reason did not say it will start again");
  let started = false;
  try { await readFile(marker, "utf8"); started = true; } catch { /* absent */ }
  check(!started, "rejected local command was started");
  let registry = { entries: [] };
  try { registry = JSON.parse(await readFile(join(dataDir, "registry.__test__.json"), "utf8")); } catch { /* absent */ }
  check(!registry.entries?.some((entry) => entry.name === "local"), "rejected local command was saved");

  asks.length = 0;
  ctx.get = (name) => {
    if (name === "sandboxPolicy") return { resolve() { return { mode: "danger-full-access" }; } };
    if (name === "approval") return { async request(req) { asks.push(req); return "rejected"; } };
    return undefined;
  };
  // The closure captured the original get. Full-access needs a fresh apply.
  await dispose(effects);
}

{
  const dataDir = join(tmp, "approval-full");
  await mkdir(dataDir, { recursive: true });
  const asks = [];
  const tools = [];
  const effects = [];
  const ctx = {
    tools: { register(definition) { tools.push(definition); return () => {}; } },
    skills: { registerProvider() { return () => {}; } },
    on() { return () => {}; },
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === "function") effects.push(disposer);
      return () => {};
    },
    get(name) {
      if (name === "sandboxPolicy") return { resolve() { return { mode: "danger-full-access" }; } };
      if (name === "approval") return { async request(req) { asks.push(req); return "rejected"; } };
      return undefined;
    },
    logger: { warn() {}, error() {}, info() {} },
  };
  await apply(ctx, { dataDir, profile: "__test__", importNativeMcp: false, trialTimeoutMs: 3000 });
  const mcpRegister = tools.find((tool) => tool.name === "mcp_register");
  let error = "";
  try {
    await mcpRegister.execute({
      name: "local",
      transport: "stdio",
      command: process.execPath,
      args: ["-e", "process.exit(1)"],
    }, { agent: { session: {} } });
  } catch (caught) {
    error = String(caught?.message ?? caught);
  }
  check(asks.length === 0, "full access asked anyway");
  check(!/not approved/.test(error), `full access was treated as a rejection: ${error}`);
  await dispose(effects);
}

{
  const dataDir = join(tmp, "approval-allow");
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "settings.json"), `${JSON.stringify({ localCommandApproval: "always-allow" })}\n`, "utf8");
  const asks = [];
  const tools = [];
  const effects = [];
  const ctx = {
    tools: { register(definition) { tools.push(definition); return () => {}; } },
    skills: { registerProvider() { return () => {}; } },
    on() { return () => {}; },
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === "function") effects.push(disposer);
      return () => {};
    },
    get(name) {
      if (name === "sandboxPolicy") return { resolve() { return { mode: "read-only" }; } };
      if (name === "approval") return { async request(req) { asks.push(req); return "rejected"; } };
      return undefined;
    },
    logger: { warn() {}, error() {}, info() {} },
  };
  await apply(ctx, { dataDir, profile: "__test__", importNativeMcp: false, trialTimeoutMs: 5000 });
  const mcpRegister = tools.find((tool) => tool.name === "mcp_register");
  const saved = await mcpRegister.execute({
    name: "local",
    transport: "stdio",
    command: process.execPath,
    args: [serverPath],
    tier: "on-demand",
  }, { agent: { session: {} } });
  check(asks.length === 0, "always-allow still asked");
  check(typeof saved.text === "string" && saved.text.includes("local"), `always-allow did not register: ${saved?.text}`);
  const again = await mcpRegister.execute({
    name: "local",
    notes: "only a note",
    tier: "on-demand",
  }, { agent: { session: {} } });
  check(asks.length === 0 && again.text.includes("updated"), "notes-only update asked or failed");
  await dispose(effects);
}

// Lazy bridge (v2): the pre-step advertises every row without launching
// anything. A native row belongs to the dsh-mcp-client; a proxied (on-demand)
// row connects only when mcp_load asks for it, and a failing server is not
// retried by later turns.
{
  const dataDir = join(tmp, "lazy-bridge");
  const startLog = join(tmp, "starts.log");
  await mkdir(dataDir, { recursive: true });
  const lazyServer = join(tmp, "lazy-server.mjs");
  await writeFile(lazyServer, `
import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
appendFileSync(${JSON.stringify(startLog)}, "x\\n");
const server = new Server({ name: "lazy", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "ping", description: "ping", inputSchema: { type: "object", additionalProperties: false } }] }));
await server.connect(new StdioServerTransport());
`, "utf8");

  function row(id, serverName, command, args) {
    return [
      "- insert:",
      `    - id: ${id}`,
      "      name: '@deepseek-ai/dsh-mcp-client'",
      "      config:",
      `        serverName: ${serverName}`,
      "        transport: stdio",
      `        command: ${JSON.stringify(command)}`,
      "        args:",
      ...args.map((item) => `          - ${JSON.stringify(item)}`),
      "",
    ].join("\n");
  }
  const patchPath = join(home, "profiles", "__test__", "cordis.patch.yml");
  await writeFile(patchPath, [
    row("mcp-native", "nativeone", process.execPath, [lazyServer]),
    row("mcp-proxied", "proxiedone", process.execPath, [lazyServer]),
    '- id: "mcp-proxied"',
    "  disabled: true",
    "",
  ].join("\n"), "utf8");
  await writeFile(
    join(dataDir, "agents.__test__.json"),
    `${JSON.stringify({ version: 1, rows: { "mcp-proxied": { tools: {} } }, snapshots: {}, notes: {} }, null, 2)}\n`,
    "utf8",
  );

  function makeHarness() {
    const routes = [];
    const tools = [];
    const effects = [];
    let preStep;
    const ctx = {
      tools: { register(definition) { tools.push(definition); return () => {}; } },
      skills: { registerProvider() { return () => {}; } },
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
        if (name === "webServer") return { register(route) { routes.push(route); return () => {}; } };
        return undefined;
      },
      logger: { warn() {}, error() {}, info() {} },
    };
    return { ctx, routes, tools, effects, preStep: () => preStep };
  }
  const logLines = async (path) => {
    try {
      return (await readFile(path, "utf8")).trim().split(/\n/).filter(Boolean).length;
    } catch {
      return 0;
    }
  };

  const runOne = makeHarness();
  await apply(runOne.ctx, { dataDir, profile: "__test__", trialTimeoutMs: 5000 });
  const agent = {
    session: { seq: 0, surface: { nodes: [] }, eventAt() { return undefined; } },
    ctx: { tools: { register() { return () => {}; } } },
  };
  const signal = { throwIfAborted() {} };
  const enter = async () => ({ kind: "enter", messages: [] });
  const first = await runOne.preStep()({ agent, signal }, enter);
  const text = first.messages?.[0]?.content?.[0]?.text ?? "";
  check(text.includes("nativeone") && text.includes("proxiedone"), `the catalog is missing rows: ${text}`);
  check((await logLines(startLog)) === 0, "the pre-step launched an MCP process");

  const mcpLoad = runOne.tools.find((tool) => tool.name === "mcp_load");
  await mcpLoad.execute({ name: "proxiedone" }, { agent, signal });
  const afterLoad = await logLines(startLog);
  check(afterLoad === 1, `mcp_load started ${afterLoad} process(es)`);
  await runOne.preStep()({ agent, signal }, enter);
  check((await logLines(startLog)) === 1, "a later turn started another process");

  let nativeError = "";
  try {
    await mcpLoad.execute({ name: "nativeone" }, { agent, signal });
  } catch (error) {
    nativeError = String(error?.message ?? error);
  }
  check(/native tier/.test(nativeError), `the bridge did not refuse a native row: ${nativeError}`);
  await dispose(runOne.effects);

  // A server that dies on startup: the failure surfaces at mcp_load, and the
  // pre-step never retries it (nothing is launched outside a load).
  const failingDir = join(tmp, "lazy-failing");
  await mkdir(failingDir, { recursive: true });
  const failCount = await logLines(failLog);
  await writeFile(patchPath, [
    row("mcp-down", "down", process.execPath, [failPath, failLog]),
    '- id: "mcp-down"',
    "  disabled: true",
    "",
  ].join("\n"), "utf8");
  await writeFile(
    join(failingDir, "agents.__test__.json"),
    `${JSON.stringify({ version: 1, rows: { "mcp-down": { tools: {} } }, snapshots: {}, notes: {} }, null, 2)}\n`,
    "utf8",
  );
  const failing = makeHarness();
  await apply(failing.ctx, { dataDir: failingDir, profile: "__test__", trialTimeoutMs: 3000 });
  const downAgent = {
    session: { seq: 0, surface: { nodes: [] }, eventAt() { return undefined; } },
    ctx: { tools: { register() { return () => {}; } } },
  };
  await failing.preStep()({ agent: downAgent, signal }, enter);
  check((await logLines(failLog)) === failCount, "the pre-step started a failing server");
  const downLoad = failing.tools.find((tool) => tool.name === "mcp_load");
  let downError = "";
  try {
    await downLoad.execute({ name: "down" }, { agent: downAgent, signal });
  } catch (error) {
    downError = String(error?.message ?? error);
  }
  check(downError !== "", "a failing server did not surface an error at mcp_load");
  const afterFail = await logLines(failLog);
  const startedAt = Date.now();
  await failing.preStep()({ agent: downAgent, signal }, enter);
  check(Date.now() - startedAt < 1000, "the pre-step blocked on the failing server");
  check((await logLines(failLog)) === afterFail, "the failing server was retried by the pre-step");

  const listed = await callRoute(failing.routes, "/skill-mcp-manager/inventory", "GET", { origin: "http://127.0.0.1:9", host: "127.0.0.1:9" });
  const down = (listed.body.rows ?? []).find((entry) => entry.serverName === "down");
  check(down?.tier === "on-demand", `the UI lost the row's tier: ${JSON.stringify(down)}`);
  await dispose(failing.effects);
}

await rm(tmp, { recursive: true, force: true });

if (failed.length > 0) {
  for (const item of failed) console.log("FAIL:", item);
  console.log("SECURITY SMOKE FAILED");
  process.exit(1);
}
console.log("SECURITY SMOKE PASSED");
