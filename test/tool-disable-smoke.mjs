// Per-tool switches (v2): an on-demand (proxied) row's disabled tools stay
// visible in the UI view but are hidden from the model-facing catalog and the
// mcp_load result, are rejected at the mcp_call boundary, and are persisted in
// the profile's agent state. A proxied row never registers native
// mcp__<server>__<tool> tools — the native dsh-mcp-client owns those.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bootPlugin } from "./helpers/boot.mjs";

const tmp = join(process.cwd(), `.test-tool-disable-${process.pid}`);
const serverPath = join(tmp, "server.mjs");

const fixture = await bootPlugin({
  tmp,
  rows: [{
    id: "mcp-demo",
    serverName: "demo",
    config: { transport: "stdio", command: process.execPath, args: [serverPath], cwd: process.cwd() },
    proxied: true,
    tools: { blocked: false },
    snapshot: {
      serverDescription: "test server",
      tools: [
        { name: "allowed", description: "Allowed tool" },
        { name: "blocked", description: "Blocked tool" },
      ],
      fetchedAt: "2026-01-01T00:00:00.000Z",
    },
  }],
});

await writeFile(serverPath, `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const server = new Server({ name: "tool-disable-test", version: "1.0.0" }, { capabilities: { tools: {} } });
const tools = [
  { name: "allowed", description: "Allowed tool", inputSchema: { type: "object", additionalProperties: false } },
  { name: "blocked", description: "Blocked tool", inputSchema: { type: "object", additionalProperties: false } },
];
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({ content: [{ type: "text", text: "called " + request.params.name }] }));
await server.connect(new StdioServerTransport());
`, "utf8");

const failed = [];
const agent = fixture.makeAgent();
const enter = async () => ({ kind: "enter", messages: [] });
await fixture.preStep({ agent, signal: { throwIfAborted() {} } }, enter);

const mcpLoad = fixture.tool("mcp_load");
const mcpCall = fixture.tool("mcp_call");
if (!mcpLoad || !mcpCall) failed.push("required tool definitions missing");

// A proxied row must not produce plugin-registered native tools.
const nativeNames = fixture.registrations
  .filter((record) => record.active && record.definition.name.startsWith("mcp__demo__"))
  .map((record) => record.definition.name);
if (nativeNames.length !== 0) failed.push(`proxied row registered native tools: ${nativeNames.join(",")}`);

if (mcpLoad) {
  const peek = await mcpLoad.execute({ name: "demo", peek: true });
  if (!peek.text.includes("allowed")) failed.push("mcp_load peek hid enabled tool");
  if (peek.text.includes("blocked")) failed.push("mcp_load peek exposed disabled tool");
}

if (mcpCall) {
  // The bridge is lazy: load the row for this session before calling a tool.
  await mcpLoad.execute({ name: "demo" }, { agent });
  let blockedError = "";
  try {
    await mcpCall.execute({ name: "demo", tool: "blocked", args: {} }, { signal: new AbortController().signal, agent });
  } catch (error) {
    blockedError = String(error?.message ?? error);
  }
  if (!/disabled/.test(blockedError)) failed.push(`mcp_call did not reject disabled tool: ${blockedError}`);
  const allowedArgs = { name: "demo", tool: "allowed", args: {} };
  const allowed = await mcpCall.execute(allowedArgs, { signal: new AbortController().signal, agent });
  const allowedText = mcpCall.output.render(allowedArgs, allowed).map((block) => block.text ?? "").join("\n");
  if (allowedText !== "called allowed") failed.push(`enabled bridge call failed: ${allowedText}`);
}

// UI switch: enable the blocked tool, then disable the allowed one.
const enableBlocked = await fixture.callRoute("/skill-mcp-manager/mcp/tool-tier", "POST", { rowId: "mcp-demo", tool: "blocked", enabled: true });
if (enableBlocked.status !== 200) failed.push(`tool-tier enable failed: ${enableBlocked.json?.error ?? enableBlocked.status}`);
if (mcpLoad) {
  const peek = await mcpLoad.execute({ name: "demo", peek: true });
  if (!peek.text.includes("allowed") || !peek.text.includes("blocked")) failed.push("enabling did not restore the blocked tool");
}
const disableAllowed = await fixture.callRoute("/skill-mcp-manager/mcp/tool-tier", "POST", { rowId: "mcp-demo", tool: "allowed", enabled: false });
if (disableAllowed.status !== 200) failed.push(`tool-tier disable failed: ${disableAllowed.json?.error ?? disableAllowed.status}`);

const persisted = await fixture.readAgents();
if (persisted?.rows?.["mcp-demo"]?.tools?.allowed !== false) {
  failed.push(`tool switch was not persisted: ${JSON.stringify(persisted?.rows)}`);
}
if (persisted?.rows?.["mcp-demo"]?.tools?.blocked !== undefined) {
  failed.push("re-enabled tool kept a stale false entry");
}

// Catalog reflects the switches on the next pre-step.
const result = await fixture.preStep({ agent, signal: { throwIfAborted() {} } }, enter);
const catalog = JSON.stringify(result.messages);
if (!catalog.includes("blocked")) failed.push("catalog hid the re-enabled tool");
if (catalog.includes("allowed")) failed.push("catalog exposed the disabled tool");

// The switch route refuses a row that is not proxied.
const tier = await fixture.callRoute("/skill-mcp-manager/mcp/tier", "POST", { rowId: "mcp-demo", tier: "native" });
if (tier.status !== 200) failed.push(`tier switch to native failed: ${tier.json?.error ?? tier.status}`);
const refuse = await fixture.callRoute("/skill-mcp-manager/mcp/tool-tier", "POST", { rowId: "mcp-demo", tool: "allowed", enabled: true });
if (refuse.status === 200) failed.push("tool-tier accepted a row that is no longer proxied");

await fixture.cleanup();

if (failed.length > 0) {
  for (const item of failed) console.log("FAIL:", item);
  console.log("TOOL DISABLE SMOKE FAILED");
  process.exit(1);
}
console.log("TOOL DISABLE SMOKE PASSED");
