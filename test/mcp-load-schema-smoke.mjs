// mcp_load schema smoke test (v2): tool snapshots (cached in the profile's
// agent state by mcp_load / the snapshot refresh) must keep the server-declared
// inputSchema, and the text mcp_load returns on BOTH the load and peek paths
// must render it. A native-tier row is not loaded by this plugin at all.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bootPlugin } from "./helpers/boot.mjs";

const tmp = join(process.cwd(), `.test-mcp-load-schema-${process.pid}`);
const serverPath = join(tmp, "server.mjs");

const widgetSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["search", "read"] },
    table_edit: {
      type: "object",
      properties: { row: { type: "integer" }, values: { type: "array", items: { type: "string" } } },
      required: ["row"],
    },
  },
  required: ["action"],
};

// "bridge" is proxied with a STALE snapshot (name + description only, no
// inputSchema): the load path must refresh it. "direct" is native — the
// dsh-mcp-client loads it, so this plugin's mcp_load refuses it.
const fixture = await bootPlugin({
  tmp,
  rows: [
    {
      id: "mcp-bridge",
      serverName: "bridge",
      config: { transport: "stdio", command: process.execPath, args: [serverPath], cwd: process.cwd() },
      proxied: true,
      snapshot: {
        serverDescription: "schema test server",
        tools: [{ name: "widget", description: "Multi-action widget" }],
        fetchedAt: "2026-01-01T00:00:00.000Z",
      },
    },
    {
      id: "mcp-direct",
      serverName: "direct",
      config: { transport: "stdio", command: process.execPath, args: [serverPath], cwd: process.cwd() },
      snapshot: { serverDescription: "schema test server", tools: [{ name: "widget", description: "Multi-action widget" }], fetchedAt: "2026-01-01T00:00:00.000Z" },
    },
  ],
});

await writeFile(serverPath, `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const server = new Server({ name: "load-schema-test", version: "1.0.0" }, { capabilities: { tools: {} } });
const tools = [
  { name: "widget", description: "Multi-action widget", inputSchema: ${JSON.stringify(widgetSchema)} },
];
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({ content: [{ type: "text", text: "called " + request.params.name }] }));
await server.connect(new StdioServerTransport());
`, "utf8");

const failed = [];
const agent = fixture.makeAgent();
await fixture.preStep({ agent, signal: { throwIfAborted() {} } }, async () => ({ kind: "enter", messages: [] }));

const mcpLoad = fixture.tool("mcp_load");
if (!mcpLoad) failed.push("mcp_load definition missing");
else {
  // 1) Non-peek load: connects, refreshes the snapshot, renders the schema.
  const loaded = await mcpLoad.execute({ name: "bridge" }, { signal: new AbortController().signal, agent });
  for (const needle of ["inputSchema", "table_edit", '"required":["row"]', '"required":["action"]']) {
    if (!loaded.text.includes(needle)) failed.push(`mcp_load result missing ${needle}`);
  }

  // 2) Persisted snapshot: the agent-state entry must carry inputSchema.
  const state = await fixture.readAgents();
  const widget = (state?.snapshots?.["mcp-bridge"]?.tools ?? []).find((tool) => tool.name === "widget");
  if (!widget?.inputSchema || widget.inputSchema.required?.join(",") !== "action") {
    failed.push(`persisted snapshot lost inputSchema: ${JSON.stringify(widget)}`);
  }

  // 3) Peek without a live connection: falls back to the persisted snapshot.
  const peek = await mcpLoad.execute({ name: "bridge", peek: true });
  for (const needle of ["inputSchema", '"required":["row"]']) {
    if (!peek.text.includes(needle)) failed.push(`mcp_load peek missing ${needle}`);
  }

  // 4) A native-tier row is loaded by the dsh-mcp-client, not by this bridge.
  let nativeError = "";
  try {
    await mcpLoad.execute({ name: "direct" }, { signal: new AbortController().signal, agent });
  } catch (error) {
    nativeError = String(error?.message ?? error);
  }
  if (!/native tier/.test(nativeError)) failed.push(`mcp_load did not refuse a native row: ${nativeError}`);
}

await fixture.cleanup();

if (failed.length > 0) {
  for (const item of failed) console.log("FAIL:", item);
  console.log("MCP LOAD SCHEMA SMOKE FAILED");
  process.exit(1);
}
console.log("MCP LOAD SCHEMA SMOKE PASSED");
