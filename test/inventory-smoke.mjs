// Unified-inventory smoke test: mount the plugin against a mock ctx that
// supplies a loader, tool schemas and a built-in provider, with a prepopulated
// registry and patch file. Verifies (1) the four MCP sources appear once each
// with the right labels, (2) the patch layer's `disabled` override round-trips
// for rows this plugin does not own, and (3) an in-place restart goes through
// the live loader entry.

import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = join(here, "..", ".test-data", "inventory-smoke-" + process.pid);
await rm(tmp, { recursive: true, force: true });
await mkdir(join(tmp, "profiles", "__test__"), { recursive: true });
// The host home must be redirected BEFORE the plugin module loads: it resolves
// DSH_HOME once, at import time.
process.env.DSH_HOME = tmp;
const { apply, setDisabledOverride, listDisabledOverrides } = await import("../lib/index.js");

const failed = [];
function check(condition, message) {
  if (!condition) failed.push(message);
}

const patchPath = join(tmp, "profiles", "__test__", "cordis.patch.yml");
const dataDir = join(tmp, "data");
await mkdir(dataDir, { recursive: true });

// One user row the manager must NOT adopt (importNativeMcp is off below), so it
// stays a "native" row in the inventory.
await writeFile(
  patchPath,
  [
    "# user patch",
    "- insert:",
    '    - id: mcp-native-one',
    '      name: "@deepseek-ai/dsh-mcp-client"',
    "      config:",
    "        serverName: native-one",
    "        transport: stdio",
    "        command: node",
    "        args:",
    "          - native.mjs",
    "",
  ].join("\n"),
  "utf8",
);

// A registry with one registry-born managed entry. `tools` + `metaFetchedAt`
// are filled so the boot warm-up does not try to connect anywhere.
await writeFile(
  join(dataDir, "registry.__test__.json"),
  JSON.stringify({
    version: 1,
    entries: [
      {
        id: "mine",
        name: "mine",
        tier: "on-demand",
        transport: "stdio",
        command: "node",
        args: ["mine.mjs"],
        env: {},
        cwd: null,
        url: null,
        headers: {},
        notes: "",
        systemEntryId: "mcp-mine",
        managed: true,
        registeredAt: "2026-10-18T00:00:00.000Z",
        lastLoadAt: null,
        lastSyncAt: "2026-10-18T00:00:00.000Z",
        tools: [{ name: "ping", description: "ping" }],
        disabledTools: [],
        serverName: "",
        serverVersion: "",
        serverTitle: "",
        serverDescription: "",
        websiteUrl: "",
        instructions: "",
        capabilities: null,
        metaFetchedAt: "2026-10-18T00:00:00.000Z",
      },
    ],
  }),
  "utf8",
);

const restarted = [];
const fiber = (state) => ({ state, restart: async () => { restarted.push(state); } });
const loaderEntries = [
  // The managed entry's own disabled shadow row.
  { options: { id: "mcp-mine", name: "@deepseek-ai/dsh-mcp-client", config: { serverName: "mine" } }, disabled: true },
  // A bundle-provided row: alive, with a real fiber.
  {
    options: {
      id: "mcp-exa",
      name: "@deepseek-ai/dsh-mcp-client",
      config: { serverName: "exa", transport: "streamable-http", url: "https://example.invalid/mcp" },
    },
    disabled: false,
    fiber: fiber(2),
  },
  // A bundle row whose fiber is disposed: restart must refuse it.
  {
    options: { id: "mcp-dead", name: "@deepseek-ai/dsh-mcp-client", config: { serverName: "dead", transport: "stdio", command: "node" } },
    disabled: false,
    fiber: fiber(4),
  },
  // Not the MCP bridge: must never be listed.
  { options: { id: "other-plugin", name: "some-other-plugin", config: { anything: true } }, disabled: false },
];
const schemas = [
  { name: "mcp__exa__search", description: "Search the web" },
  { name: "mcp__exa__fetch", description: "Fetch a page" },
  { name: "computer_use_click", description: "Click something" },
  { name: "some_other_tool", description: "Not a provider tool" },
];

const routes = [];
const commands = [];
const ctx = {
  tools: { register() { return () => {}; } },
  skills: { registerProvider() { return () => {}; } },
  on() { return () => {}; },
  effect(fn) { const disposer = fn(); return () => { if (typeof disposer === "function") disposer(); }; },
  get(name) {
    if (name === "webServer") return { register(route) { routes.push(route); return () => {}; } };
    if (name === "commands") return { register(definition) { commands.push(definition); return () => {}; } };
    if (name === "profileContext") return { name: "__test__", patchPath };
    if (name === "loader") return { entries: () => loaderEntries };
    if (name === "tools") return { schemas: () => schemas };
    if (name === "computerUse") return { click() {} };
    return undefined;
  },
  logger: { warn() {}, error() {}, info() {} },
};

await apply(ctx, { dataDir, profile: "__test__", importNativeMcp: false });
await new Promise((resolve) => setTimeout(resolve, 50));

function makeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  let i = 0;
  return {
    method,
    url,
    headers: { origin: "http://127.0.0.1:7404", host: "127.0.0.1:7404" },
    [Symbol.asyncIterator]() {
      return { async next() { return i < chunks.length ? { value: chunks[i++], done: false } : { done: true }; } };
    },
  };
}
function makeRes() {
  const res = { status: 0, body: "" };
  res.writeHead = (status) => { res.status = status; };
  res.end = (chunk) => { res.body = chunk ?? ""; };
  return res;
}
const bodyOf = (res) => (res.body ? JSON.parse(res.body) : {});
const routeByPath = (path) => routes.find((route) => route.path === path);

const inventoryRoute = routeByPath("/skill-mcp-manager/inventory");
const toggleRoute = routeByPath("/skill-mcp-manager/row/toggle");
const restartRoute = routeByPath("/skill-mcp-manager/row/restart");
const tierRoute = routeByPath("/skill-mcp-manager/mcp/tier");
check(inventoryRoute !== undefined, "inventory route was not registered");
check(toggleRoute !== undefined, "row/toggle route was not registered");
check(restartRoute !== undefined, "row/restart route was not registered");

async function callInventory() {
  const res = makeRes();
  await inventoryRoute.handler(makeReq("GET", "/skill-mcp-manager/inventory"), res);
  return { status: res.status, body: bodyOf(res) };
}
const named = (inv) => new Map((inv.body.servers ?? []).map((server) => [server.serverKey ?? server.serverName, server]));

// ── the four sources ───────────────────────────────────────────────────────
let inv = await callInventory();
check(inv.status === 200, `inventory GET status ${inv.status}`);
{
  const map = named(inv);
  console.log("servers:", [...map.keys()].join(", "), "| counts:", JSON.stringify(inv.body.counts));
  check(map.get("mine")?.source === "managed", "the registry entry should be managed");
  check(map.get("native-one")?.source === "native", "an unadopted user row should be native");
  check(map.get("exa")?.source === "bundle", "a loader row should be a bundle row");
  check(map.get("computer-use")?.source === "builtin", "the built-in provider should be listed");
  check(!map.has("some-other-plugin"), "a non-bridge loader entry must not be listed");
  const counts = inv.body.counts ?? {};
  check(
    counts.managed === 1 && counts.native === 1 && counts.bundle === 2 && counts.builtin === 1,
    `counts wrong: ${JSON.stringify(counts)}`,
  );
  check(map.get("exa")?.transport === "streamable-http", "bundle transport should be reported");
  check(map.get("exa")?.live?.toolCount === 2, "bundle tools should come from the live schemas");
  check(map.get("computer-use")?.live?.toolCount === 1, "builtin tools should be derived by naming convention");
  check(map.get("mine")?.live?.phase === "on-demand", "the managed phase should be its tier");
  check(map.get("native-one")?.config === undefined || map.get("native-one")?.enabled === true, "the native row should read as enabled");
}

// ── patch-layer overrides for rows this plugin does not own ────────────────
{
  // Disabling a bundle row writes an explicit override.
  const res = makeRes();
  await toggleRoute.handler(makeReq("POST", "/skill-mcp-manager/row/toggle", { id: "mcp-exa", enabled: false }), res);
  check(res.status === 200, `disabling a bundle row failed: ${res.body}`);
  let text = await readFile(patchPath, "utf8");
  check(listDisabledOverrides(text).get("mcp-exa") === true, "the override was not written");
  inv = await callInventory();
  check(named(inv).get("exa")?.enabled === false, "the bundle row should read as disabled");

  // Re-enabling cannot come from absence (the bundle holds the row), so the
  // override stays with `disabled: false` — and repeated toggles must not stack.
  await toggleRoute.handler(makeReq("POST", "/skill-mcp-manager/row/toggle", { id: "mcp-exa", enabled: true }), makeRes());
  text = await readFile(patchPath, "utf8");
  check(listDisabledOverrides(text).get("mcp-exa") === false, "a bundle row must be re-enabled with disabled: false");
  check((text.match(/- id: "mcp-exa"/g) ?? []).length === 1, "repeated toggles must not stack override items");

  // A user-layer row the plugin did not adopt: enabling DROPS the override.
  await toggleRoute.handler(makeReq("POST", "/skill-mcp-manager/row/toggle", { id: "mcp-native-one", enabled: false }), makeRes());
  text = await readFile(patchPath, "utf8");
  check(listDisabledOverrides(text).get("mcp-native-one") === true, "the native row's override was not written");
  await toggleRoute.handler(makeReq("POST", "/skill-mcp-manager/row/toggle", { id: "mcp-native-one", enabled: true }), makeRes());
  text = await readFile(patchPath, "utf8");
  check(!listDisabledOverrides(text).has("mcp-native-one"), "enabling a user-layer row must drop the override");
  check(text.includes("serverName: native-one"), "the native row itself must survive");

  // An id that would inject YAML lines is refused.
  const bad = makeRes();
  await toggleRoute.handler(makeReq("POST", "/skill-mcp-manager/row/toggle", { id: 'x"\n  evil: true', enabled: false }), bad);
  check(bad.status === 400, "a YAML-injecting row id was accepted");

  // Overrides survive a reconcile triggered by another action.
  await toggleRoute.handler(makeReq("POST", "/skill-mcp-manager/row/toggle", { id: "mcp-exa", enabled: false }), makeRes());
  await tierRoute.handler(makeReq("POST", "/skill-mcp-manager/mcp/tier", { name: "mine", tier: "disabled" }), makeRes());
  text = await readFile(patchPath, "utf8");
  check(listDisabledOverrides(text).get("mcp-exa") === true, "reconcile dropped the appended override");
  check(text.includes("End managed MCP servers"), "the managed block disappeared after reconcile");
}

// ── in-place restart ──────────────────────────────────────────────────────
{
  const ok = makeRes();
  await restartRoute.handler(makeReq("POST", "/skill-mcp-manager/row/restart", { name: "exa" }), ok);
  check(ok.status === 200 && restarted.length === 1, `restart failed: ${ok.body}`);

  const disposed = makeRes();
  await restartRoute.handler(makeReq("POST", "/skill-mcp-manager/row/restart", { name: "dead" }), disposed);
  check(disposed.status === 400 && /cannot be restarted/.test(bodyOf(disposed).error ?? ""), `disposed fiber: ${disposed.body}`);

  const disabled = makeRes();
  await restartRoute.handler(makeReq("POST", "/skill-mcp-manager/row/restart", { name: "mine" }), disabled);
  check(disabled.status === 400 && /enable it first/.test(bodyOf(disabled).error ?? ""), `disabled restart: ${disabled.body}`);

  const unknown = makeRes();
  await restartRoute.handler(makeReq("POST", "/skill-mcp-manager/row/restart", { name: "nope" }), unknown);
  check(unknown.status === 400, "an unknown server must refuse a restart");
}

// ── pure override helpers ─────────────────────────────────────────────────
{
  const one = setDisabledOverride("[]\n", "mcp-a", true);
  check(one.trim() === '- id: "mcp-a"\n  disabled: true', `empty-patch append wrong: ${JSON.stringify(one)}`);
  const two = setDisabledOverride(one, "mcp-a", false);
  check(listDisabledOverrides(two).get("mcp-a") === false, "re-toggle did not replace the item");
  check(listDisabledOverrides(two).size === 1, "re-toggle stacked items");
  check(setDisabledOverride(two, "mcp-a", null).trim() === "", "dropping the override left text behind");

  // An override another tool wrote (unquoted, plus-style) is replaced, not
  // duplicated, and unrelated rows survive.
  const foreign = [
    "# c",
    "- insert:",
    "    - id: x",
    '      name: "@deepseek-ai/dsh-mcp-client"',
    "      config:",
    "        serverName: x",
    "",
    "- id: mcp-exa",
    "  disabled: true",
    "",
  ].join("\n");
  const after = setDisabledOverride(foreign, "mcp-exa", false);
  check(listDisabledOverrides(after).size === 1 && listDisabledOverrides(after).get("mcp-exa") === false, "a foreign override was not replaced");
  check(after.includes("serverName: x"), "unrelated rows must survive an override write");
}

await rm(tmp, { recursive: true, force: true }).catch(() => {});
if (failed.length > 0) {
  console.error("INVENTORY SMOKE FAILED:");
  for (const message of failed) console.error(" - " + message);
  process.exit(1);
}
console.log("INVENTORY SMOKE PASSED");
