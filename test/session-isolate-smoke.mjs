// Per-session MCP bridge instances (v2): two agents each get their own stdio
// server process through the on-demand bridge; a call in A does not see B's
// runtime, disposing A does not drop B, and a snapshot refresh does not leave a
// shared live instance.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bootPlugin } from "./helpers/boot.mjs";

const tmp = join(process.cwd(), `.test-session-isolate-${process.pid}`);
const serverPath = join(tmp, "server.mjs");

const fixture = await bootPlugin({
  tmp,
  rows: [{
    id: "mcp-demo",
    serverName: "demo",
    config: { transport: "stdio", command: process.execPath, args: [serverPath], cwd: process.cwd() },
    proxied: true,
    snapshot: {
      serverDescription: "test server",
      tools: [{ name: "whoami", description: "Return this process id" }],
      fetchedAt: "2026-01-01T00:00:00.000Z",
    },
  }],
});

await writeFile(serverPath, `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const id = "pid-" + process.pid + "-" + Math.random().toString(16).slice(2);
const server = new Server({ name: "session-isolate-test", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "whoami", description: "Return this process id", inputSchema: { type: "object", additionalProperties: false } }],
}));
server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: id }] }));
await server.connect(new StdioServerTransport());
`, "utf8");

const failed = [];
const mcpLoad = fixture.tool("mcp_load");
const mcpCall = fixture.tool("mcp_call");
if (!mcpLoad || !mcpCall) failed.push("bridge tools missing");

const agentA = fixture.makeAgent();
const agentB = fixture.makeAgent();
const enter = async () => ({ kind: "enter", messages: [] });
const signal = { throwIfAborted() {} };
await fixture.preStep({ agent: agentA, signal }, enter);
await fixture.preStep({ agent: agentB, signal }, enter);

await mcpLoad.execute({ name: "demo" }, { agent: agentA });
await mcpLoad.execute({ name: "demo" }, { agent: agentB });

const whoami = { name: "demo", tool: "whoami", args: {} };
const callText = async (agent) => {
  const value = await mcpCall.execute(whoami, { signal: new AbortController().signal, agent });
  return mcpCall.output.render(whoami, value).map((block) => block.text ?? "").join("\n");
};
const idA = await callText(agentA);
const idB = await callText(agentB);
if (!idA || !idB) failed.push("whoami returned empty id");
if (idA === idB) failed.push(`sessions shared one MCP process: ${idA}`);

for (const dispose of agentA.sessionEffects.reverse()) await dispose();
let afterA = "";
try {
  afterA = await callText(agentA);
} catch (error) {
  afterA = String(error?.message ?? error);
}
if (!/not loaded/.test(afterA)) failed.push(`disposing A should drop A's instance: ${afterA}`);
const stillB = await callText(agentB);
if (stillB !== idB) failed.push(`disposing A affected B: ${stillB}`);

// The UI snapshot refresh connects, reads, and closes; B's live instance must
// survive it (v2 route: POST /row/snapshot { rowId }).
const refreshed = await fixture.callRoute("/skill-mcp-manager/row/snapshot", "POST", { rowId: "mcp-demo" });
if (refreshed.status !== 200 || refreshed.json?.ok !== true) {
  failed.push(`refresh snapshot failed: ${refreshed.json?.error ?? refreshed.status}`);
}
const stillBAfterRefresh = await callText(agentB);
if (stillBAfterRefresh !== idB) failed.push(`snapshot refresh replaced B's instance: ${stillBAfterRefresh}`);

// The persisted snapshot carries the refreshed tool list.
const agents = await fixture.readAgents();
if (!Array.isArray(agents?.snapshots?.["mcp-demo"]?.tools) || agents.snapshots["mcp-demo"].tools[0]?.name !== "whoami") {
  failed.push(`snapshot was not persisted: ${JSON.stringify(agents?.snapshots)}`);
}

await fixture.cleanup();

if (failed.length > 0) {
  for (const item of failed) console.log("FAIL:", item);
  console.log("SESSION ISOLATE SMOKE FAILED");
  process.exit(1);
}
console.log("SESSION ISOLATE SMOKE PASSED");
