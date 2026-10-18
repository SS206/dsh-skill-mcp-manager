// Unified MCP inventory: one list of every MCP server this deployment knows
// about, whichever layer owns it.
//
// Sources, in the order they are shown:
//   managed — this plugin's registry entries (adopted native rows plus the
//             ones registered here): tiers, per-tool switches, session state
//   native  — dsh-mcp-client rows still in the user patch layer that this
//             plugin deliberately did NOT adopt (a loader expression it could
//             not evaluate, importNativeMcp: false, a foreign row)
//   bundle  — rows another bundle contributed to the composed loader tree
//   builtin — harness services that present an MCP-shaped tool set
//
// The module is pure: the caller gathers the facts (registry entries, patch
// text, live loader entries, model-facing tool schemas) and this merges them.
// Discovery mirrors dsh-mcp-manager-plus, whose three sources (user row /
// bundle loader entry / builtin provider) are the ones that actually exist on
// DSH 0.2.0-rc.2.

/** Cordis fiber states, mirrored as the readable phase the browser shows. */
export const FIBER_PHASE = { 0: "pending", 1: "loading", 2: "active", 3: "failed", 4: null, 5: "unloading" };
/** Cordis `FiberState.DISPOSED`: the fiber is gone and cannot be restarted. */
export const FIBER_DISPOSED = 4;
/** The MCP bridge package: the `name:` every managed row carries. */
export const MCP_CLIENT_PACKAGE = "@deepseek-ai/dsh-mcp-client";

/** Readable phase of one live loader entry. */
export function phaseOf(entry, disabled) {
  if (disabled) return "disabled";
  if (entry === undefined) return "pending";
  const fiber = entry.fiber;
  if (fiber === undefined) return entry.disabled === true ? "disabled" : "pending";
  return FIBER_PHASE[fiber.state] ?? null;
}

/** Every model-facing tool schema, defensively read. */
export function schemasOf(ctx) {
  let tools;
  try {
    tools = typeof ctx?.get === "function" ? ctx.get("tools") : undefined;
  } catch {
    tools = undefined;
  }
  if (tools === undefined) tools = ctx?.tools;
  if (tools === undefined || typeof tools.schemas !== "function") return [];
  try {
    return tools.schemas() ?? [];
  } catch {
    return [];
  }
}

/**
 * The MCP tools one server currently contributes to the model. Names are
 * `mcp__<serverName>__<rawName>`; the separating `__` is the LAST one, which is
 * the bridge's own naming contract.
 */
export function toolsOfServer(schemas, serverName) {
  const prefix = `mcp__${serverName}__`;
  const found = [];
  for (const schema of Array.isArray(schemas) ? schemas : []) {
    const name = schema?.name;
    if (typeof name !== "string" || !name.startsWith(prefix)) continue;
    found.push({
      name: name.slice(prefix.length),
      fullName: name,
      description: typeof schema.description === "string" ? schema.description : "",
    });
  }
  found.sort((a, b) => a.name.localeCompare(b.name));
  return found;
}

/**
 * Tools a built-in provider service contributes. The service publishes no
 * catalog of its own names, so the list is derived by the provider's naming
 * convention (`computerUse` → `computer_use_`). A service with no matching
 * tools reports an empty list rather than a wrong one.
 */
export function toolsOfBuiltin(schemas, key) {
  const snake = String(key).replace(/[A-Z]/gu, (c) => `_${c.toLowerCase()}`);
  const found = [];
  for (const schema of Array.isArray(schemas) ? schemas : []) {
    const name = schema?.name;
    if (typeof name !== "string" || name.startsWith("mcp__")) continue;
    if (!name.startsWith(`${snake}_`) && !name.startsWith(`${snake}-`)) continue;
    found.push({
      name,
      fullName: name,
      description: typeof schema.description === "string" ? schema.description : "",
    });
  }
  found.sort((a, b) => a.name.localeCompare(b.name));
  return found;
}

/**
 * Live loader entries that mount the MCP bridge, normalized. The raw entry is
 * kept so a restart can re-run it in place.
 */
export function loaderMcpEntries(loader) {
  if (loader === undefined || loader === null || typeof loader.entries !== "function") return [];
  let all;
  try {
    all = loader.entries();
  } catch {
    return [];
  }
  const out = [];
  for (const entry of Array.isArray(all) ? all : []) {
    const options = entry?.options ?? {};
    if (options.name !== MCP_CLIENT_PACKAGE) continue;
    const config = options.config;
    if (config === null || typeof config !== "object") continue;
    const disabled = entry.disabled === true;
    out.push({
      id: typeof options.id === "string" ? options.id : "",
      serverName: typeof config.serverName === "string" ? config.serverName : "",
      config,
      disabled,
      phase: phaseOf(entry, disabled),
      entry,
    });
  }
  return out;
}

/**
 * Merge the sources into one list. The first source wins on a name clash and
 * the relative order inside each source is preserved, so the caller decides
 * what is shown first.
 * @returns `{ servers, counts }`.
 */
export function mergeInventory({ managed = [], native = [], bundle = [], builtin = [] } = {}) {
  const claimed = new Set();
  const servers = [];
  const counts = { managed: 0, native: 0, bundle: 0, builtin: 0 };
  for (const [source, rows] of [["managed", managed], ["native", native], ["bundle", bundle], ["builtin", builtin]]) {
    for (const row of rows) {
      const key = firstKey(row);
      if (key === "" || claimed.has(key)) continue;
      claimed.add(key);
      counts[source] += 1;
      servers.push({ ...row, serverKey: key, source });
    }
  }
  return { servers, counts };
}

/**
 * The name a row is claimed and displayed under. A managed row is keyed by its
 * registry name; every other row carries the loader's \`config.serverName\`.
 * The model-facing \`serverName\` of a managed row is the server's own
 * self-reported implementation name — a different thing, and often empty.
 */
function firstKey(row) {
  for (const candidate of [row?.serverKey, row?.serverName, row?.name]) {
    if (typeof candidate === "string" && candidate !== "") return candidate;
  }
  return "";
}
