// Unified-inventory smoke test (v2): every MCP row the booted profile reaches
// is listed once, with the right source label — the user patch layer, a bundle
// layer (static) or a loader-only row (live), plus the harness's built-in tool
// providers. Verifies the tier levers (patch-layer `disabled` overrides),
// in-place restart, and the pure override helpers.

import { join } from "node:path";
import { bootPlugin } from "./helpers/boot.mjs";
import { setDisabledOverride, listDisabledOverrides } from "../lib/rows.js";

const tmp = join(process.cwd(), ".test-data", "inventory-smoke-" + process.pid);

const restarted = [];
const fiber = (state) => ({ state, restart: async () => { restarted.push(state); } });
const loaderEntries = [
  {
    options: {
      id: "mcp-exa",
      name: "@deepseek-ai/dsh-mcp-client",
      config: { serverName: "exa", transport: "streamable-http", url: "https://example.invalid/mcp" },
    },
    disabled: false,
    fiber: fiber(2),
  },
  {
    options: { id: "mcp-dead", name: "@deepseek-ai/dsh-mcp-client", config: { serverName: "dead", transport: "stdio", command: "node" } },
    disabled: false,
    fiber: fiber(4),
  },
  { options: { id: "other-plugin", name: "some-other-plugin", config: { anything: true } }, disabled: false },
];
const schemas = [
  { name: "mcp__exa__search", description: "Search the web" },
  { name: "mcp__exa__fetch", description: "Fetch a page" },
  { name: "computer_use_click", description: "Click something" },
  { name: "some_other_tool", description: "Not a provider tool" },
];

const fixture = await bootPlugin({
  tmp,
  rows: [
    { id: "mcp-native-one", serverName: "native-one", config: { transport: "stdio", command: "node", args: ["native.mjs"] } },
    {
      id: "mcp-mine",
      serverName: "mine",
      config: { transport: "stdio", command: "node", args: ["mine.mjs"] },
      proxied: true,
      snapshot: { tools: [{ name: "ping", description: "ping" }], fetchedAt: "2026-10-18T00:00:00.000Z" },
    },
  ],
  services: {
    loader: { entries: () => loaderEntries },
    tools: { schemas: () => schemas },
    computerUse: { click() {} },
  },
});

const failed = [];
const check = (condition, message) => { if (!condition) failed.push(message); };

async function callInventory(url = "/skill-mcp-manager/inventory") {
  return await fixture.callRoute("/skill-mcp-manager/inventory", "GET", undefined, { url });
}
const named = (json) => new Map((json?.rows ?? []).map((row) => [row.serverKey ?? row.serverName, row]));

let inv = (await callInventory()).json;
{
  const map = named(inv);
  console.log("rows:", [...map.keys()].join(", "), "| counts:", JSON.stringify(inv?.counts));
  check(map.get("mine")?.source === "user", "a user-layer row should be source=user");
  check(map.get("native-one")?.source === "user", "an unproxied user row should be user");
  check(map.get("native-one")?.tier === "native", "an unproxied user row should be native");
  check(map.get("exa")?.source === "bundle", "a loader-only row should be a bundle row");
  check(!map.has("some-other-plugin"), "a non-bridge loader entry must not be listed");
  const builtin = new Map((inv?.builtin ?? []).map((row) => [row.serverKey, row]));
  check(builtin.get("computer-use")?.live?.toolCount === 1, "builtin tools should be derived by naming convention");
  check(inv?.counts?.user === 2 && inv?.counts?.bundle === 2 && inv?.counts?.builtin === 1, `counts wrong: ${JSON.stringify(inv?.counts)}`);
  check(map.get("exa")?.transport === "streamable-http", "bundle transport should be reported");
  check(map.get("exa")?.live?.toolCount === 2, "bundle tools should come from the live schemas");
  check(map.get("mine")?.tier === "on-demand", "a proxied row should be on-demand");
  check(map.get("mine")?.live?.phase === "proxied", "a proxied row's phase should say so");
  check(map.get("mine")?.live?.toolCount === 1, "a proxied row's tools should come from its snapshot");
}

// ── the tier levers ───────────────────────────────────────────────────────
{
  const off = await fixture.callRoute("/skill-mcp-manager/mcp/tier", "POST", { rowId: "mcp-mine", tier: "off" });
  check(off.status === 200, `turning a proxied row off failed: ${off.json?.error ?? off.status}`);
  const agents = await fixture.readAgents();
  check(agents?.rows?.["mcp-mine"] === undefined, "the proxied record should be gone after switching to off");
  check(listDisabledOverrides(await fixture.readPatch()).get("mcp-mine") === true, "the holding override must stay");

  const native = await fixture.callRoute("/skill-mcp-manager/mcp/tier", "POST", { rowId: "mcp-mine", tier: "native" });
  check(native.status === 200, `switching back to native failed: ${native.json?.error ?? native.status}`);
  check(!listDisabledOverrides(await fixture.readPatch()).has("mcp-mine"), "the override should be dropped for a native user row");

  await fixture.callRoute("/skill-mcp-manager/row/toggle", "POST", { rowId: "mcp-native-one" });
  check(listDisabledOverrides(await fixture.readPatch()).get("mcp-native-one") === true, "the user row's override was not written");
  await fixture.callRoute("/skill-mcp-manager/row/toggle", "POST", { rowId: "mcp-native-one" });
  check(!listDisabledOverrides(await fixture.readPatch()).has("mcp-native-one"), "enabling a user-layer row must drop the override");
  check((await fixture.readPatch()).includes("serverName: native-one"), "the native row itself must survive");

  await fixture.callRoute("/skill-mcp-manager/row/toggle", "POST", { rowId: "mcp-exa" });
  check(listDisabledOverrides(await fixture.readPatch()).get("mcp-exa") === true, "the bundle row's override was not written");
  await fixture.callRoute("/skill-mcp-manager/row/toggle", "POST", { rowId: "mcp-exa" });
  const patch = await fixture.readPatch();
  check(listDisabledOverrides(patch).get("mcp-exa") === false, "a bundle row must be re-enabled with disabled: false");
  check((patch.match(/- id: "mcp-exa"/g) ?? []).length === 1, "repeated toggles must not stack override items");

  const bad = await fixture.callRoute("/skill-mcp-manager/row/toggle", "POST", { rowId: 'x"\n  evil: true' });
  check(bad.status === 400, "a YAML-injecting row id was accepted");

  inv = (await callInventory()).json;
  check(named(inv).get("exa")?.enabled === true, "the bundle row should read as enabled again");
}

// ── in-place restart ──────────────────────────────────────────────────────
{
  const ok = await fixture.callRoute("/skill-mcp-manager/row/restart", "POST", { name: "exa" });
  check(ok.status === 200 && restarted.length === 1, `restart failed: ${ok.json?.error ?? ok.status}`);

  const disposed = await fixture.callRoute("/skill-mcp-manager/row/restart", "POST", { name: "dead" });
  check(disposed.status === 400 && /cannot be restarted/.test(disposed.json?.error ?? ""), `disposed fiber: ${JSON.stringify(disposed.json)}`);

  const proxied = await fixture.callRoute("/skill-mcp-manager/row/restart", "POST", { name: "mine" });
  check(proxied.status === 400 && /not mounted/.test(proxied.json?.error ?? ""), `proxied restart: ${JSON.stringify(proxied.json)}`);

  const unknown = await fixture.callRoute("/skill-mcp-manager/row/restart", "POST", { name: "nope" });
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

await fixture.cleanup();

if (failed.length > 0) {
  console.error("INVENTORY SMOKE FAILED:");
  for (const message of failed) console.error(" - " + message);
  process.exit(1);
}
console.log("INVENTORY SMOKE PASSED");
