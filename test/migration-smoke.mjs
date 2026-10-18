// One-time v1 → v2 migration smoke test.
//
// A v1 install left a "managed" span in the profile patch (marker comments + a
// disabled shadow copy of every registry row) and a registry.<profile>.json
// holding the real definitions. v2 has no managed span and no registry: boot
// must dismantle the span, restore the adopted rows verbatim (expressions
// intact, original disabled flags), express the old tiers with the v2 levers
// (on-demand → override + agent record; disabled → override; eager → native),
// re-emit registry-born rows from the field model, and archive the registry.

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { bootPlugin } from "./helpers/boot.mjs";

const tmp = join(process.cwd(), `.test-migration-${process.pid}`);

const TAVILY_ROW = [
  "    - id: mcp-tavily",
  "      name: '@deepseek-ai/dsh-mcp-client'",
  "      config:",
  "        serverName: tavily",
  "        transport: streamable-http",
  "        url: 'http://127.0.0.1:1/mcp/'",
  "        toolCallTimeoutMs: 120000",
  "      disabled: true",
].join("\n");

const OFF_ROW = [
  "    - id: mcp-off",
  "      name: '@deepseek-ai/dsh-mcp-client'",
  "      config:",
  "        serverName: off-server",
  "        transport: stdio",
  "        command: node",
  "        args:",
  "          - '-e'",
  "          - ''",
  "      disabled: true",
].join("\n");

const rawPatch = [
  "# unrelated comment — must survive byte-for-byte",
  "- id: some-oauth-plugin",
  "  name: llm-grok-build-oauth",
  "  config:",
  "    mode: oauth",
  "",
  "# ── Managed MCP servers (dsh-skill-mcp-manager, disabled shadow entries) ──",
  "- insert:",
  TAVILY_ROW,
  OFF_ROW,
  "# ── End managed MCP servers (dsh-skill-mcp-manager) ──",
  "",
].join("\n") + "\n";

const legacyRegistry = {
  version: 1,
  entries: [
    {
      id: "tavily",
      name: "tavily",
      tier: "on-demand",
      transport: "streamable-http",
      command: null,
      args: [],
      env: {},
      cwd: null,
      url: "http://127.0.0.1:1/mcp/",
      headers: {},
      notes: "",
      systemEntryId: "mcp-tavily",
      tools: [{ name: "search", description: "Search" }],
      disabledTools: ["deepsearch"],
      serverDescription: "Tavily search",
      metaFetchedAt: "2026-01-01T00:00:00.000Z",
      rawConfig: { serverName: "tavily", transport: "streamable-http", url: "http://127.0.0.1:1/mcp/", toolCallTimeoutMs: 120000 },
      rawEntryText: TAVILY_ROW,
      rawDisabled: false,
    },
    {
      id: "off-server",
      name: "off-server",
      tier: "disabled",
      transport: "stdio",
      command: "node",
      args: ["-e", ""],
      env: {},
      cwd: null,
      url: null,
      headers: {},
      notes: "",
      systemEntryId: "mcp-off",
      tools: [],
      disabledTools: [],
      rawConfig: { serverName: "off-server", transport: "stdio", command: "node", args: ["-e", ""] },
      rawEntryText: OFF_ROW,
      rawDisabled: true,
    },
    {
      // Registry-born (registered through mcp_register while v1 managed this
      // profile): no raw text, re-emitted from the field model and left native.
      id: "nativeone",
      name: "nativeone",
      tier: "eager",
      transport: "stdio",
      command: "node",
      args: ["-e", ""],
      env: { GREETING: "hi" },
      cwd: null,
      url: null,
      headers: {},
      notes: "",
      systemEntryId: "mcp-nativeone",
      tools: [],
      disabledTools: [],
      rawConfig: null,
      rawEntryText: null,
      rawDisabled: false,
    },
  ],
};

const failed = [];
const fixture = await bootPlugin({ tmp, rawPatch, rawRegistry: legacyRegistry });

// The registry file must exist before the assertions below (boot archived it).
try {
  const dataDir = fixture.dataDir;
  const files = await readdir(dataDir);
  if (files.some((name) => name === "registry.__test__.json")) failed.push("the legacy registry file was not archived");
  if (!files.some((name) => name.startsWith("registry.__test__.json.migrated-"))) {
    failed.push(`legacy registry archive missing: ${files.join(", ")}`);
  }
} catch (error) {
  failed.push(`registry check failed: ${String(error?.message ?? error)}`);
}

const patch = await fixture.readPatch();
if (patch.includes("Managed MCP servers")) failed.push("the v1 managed span survived the migration");
if (!patch.includes("# unrelated comment — must survive byte-for-byte")) failed.push("unrelated comment was lost");
if (!patch.includes("llm-grok-build-oauth")) failed.push("unrelated plugin row was lost");

// Adopted rows are restored verbatim (their own disabled flag kept) and the
// on-demand/disabled tiers gain a holding override.
if (!patch.includes("serverName: tavily")) failed.push("adopted row tavily was not restored");
if (!patch.includes("serverName: off-server")) failed.push("adopted row off-server was not restored");
if (!patch.includes("serverName: nativeone")) failed.push("registry-born row was not re-emitted");
if (!/^- id: "mcp-tavily"\n  disabled: true$/m.test(patch)) failed.push(`tavily holding override missing:\n${patch}`);
if (!/^- id: "mcp-off"\n  disabled: true$/m.test(patch)) failed.push("off-server holding override missing");

const agents = await fixture.readAgents();
if (agents?.rows?.["mcp-tavily"] === undefined) failed.push("on-demand row lost its agent record");
if (agents?.rows?.["mcp-off"] !== undefined) failed.push("a disabled row must not be proxied");
if (agents?.rows?.["mcp-nativeone"] !== undefined) failed.push("a native (eager) row must not be proxied");
if (JSON.stringify(agents?.rows?.["mcp-tavily"]?.tools) !== JSON.stringify({ deepsearch: false })) {
  failed.push(`per-tool switches were not carried over: ${JSON.stringify(agents?.rows?.["mcp-tavily"]?.tools)}`);
}

// The discovered inventory agrees with the migrated patch.
const inventory = await fixture.callRoute("/skill-mcp-manager/inventory", "GET");
const byName = new Map((inventory.json?.rows ?? []).map((row) => [row.serverName, row]));
if (byName.get("tavily")?.tier !== "on-demand") failed.push(`tavily tier after migration: ${byName.get("tavily")?.tier}`);
if (byName.get("off-server")?.tier !== "off") failed.push(`off-server tier after migration: ${byName.get("off-server")?.tier}`);
if (byName.get("nativeone")?.tier !== "native") failed.push(`nativeone tier after migration: ${byName.get("nativeone")?.tier}`);
// A second boot must be a no-op (no managed span, no registry): the same rows.
const second = await bootPlugin({ tmp, rawPatch: patch });
const secondPatch = await second.readPatch();
if (secondPatch !== patch) failed.push("a second boot rewrote the migrated patch");
await second.cleanup();

await fixture.cleanup();

if (failed.length > 0) {
  for (const item of failed) console.log("FAIL:", item);
  console.log("MIGRATION SMOKE FAILED");
  process.exit(1);
}
console.log("MIGRATION SMOKE PASSED");
