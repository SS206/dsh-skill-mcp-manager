// mcp_call parameter-shape guard + tool-call error context smoke test (v2).
// Verifies that:
//   1. well-shaped bridge calls still succeed (incl. omitted args for no-arg tools);
//   2. nested/malformed mcp_call parameters are rejected early with the correct
//      shape spelled out (never auto-unwrapped) instead of reaching the server
//      as params.name=undefined and dying as an opaque -32602;
//   3. protocol-level tool-call failures (server-side JSON-RPC errors) and
//      isError results carry the call context (server/tool, arguments sent,
//      inputSchema) on the on-demand bridge;
//   4. a native-tier row is not callable through the bridge at all.
// Uses an isolated local stdio MCP server and a temp profile.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bootPlugin } from "./helpers/boot.mjs";

const tmp = join(process.cwd(), `.test-mcp-call-guard-${process.pid}`);
const serverPath = join(tmp, "server.mjs");

const toolsSnapshot = ["echo", "noargs", "fail", "softfail"].map((name) => ({ name, description: name }));

const fixture = await bootPlugin({
  tmp,
  rows: [
    {
      id: "mcp-demo",
      serverName: "demo",
      config: { transport: "stdio", command: process.execPath, args: [serverPath], cwd: process.cwd() },
      proxied: true,
      snapshot: { serverDescription: "test server", tools: toolsSnapshot, fetchedAt: "2026-01-01T00:00:00.000Z" },
    },
    {
      id: "mcp-native",
      serverName: "nativebridge",
      config: { transport: "stdio", command: process.execPath, args: [serverPath], cwd: process.cwd() },
      snapshot: { serverDescription: "test server", tools: toolsSnapshot, fetchedAt: "2026-01-01T00:00:00.000Z" },
    },
  ],
});

await writeFile(serverPath, `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const server = new Server({ name: "call-guard-test", version: "1.0.0" }, { capabilities: { tools: {} } });
const tools = [
  { name: "echo", description: "Echo tool", inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] } },
  { name: "noargs", description: "No-arg tool", inputSchema: { type: "object", additionalProperties: false } },
  { name: "fail", description: "Always fails server-side", inputSchema: { type: "object", additionalProperties: false } },
  { name: "softfail", description: "Returns an isError result", inputSchema: { type: "object", additionalProperties: false } },
];
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "fail") throw new Error("boom-intentional");
  if (request.params.name === "softfail") {
    return { content: [{ type: "text", text: "soft failure: bad thing happened" }], isError: true };
  }
  return { content: [{ type: "text", text: "called " + request.params.name + " " + JSON.stringify(request.params.arguments ?? {}) }] };
});
await server.connect(new StdioServerTransport());
`, "utf8");

async function expectError(promise, patterns, label) {
  try {
    await promise;
    return `${label}: expected rejection but resolved`;
  } catch (error) {
    const message = String(error?.message ?? error);
    for (const pattern of patterns) {
      if (!pattern.test(message)) return `${label}: error message missing ${pattern} — got: ${JSON.stringify(message)}`;
    }
    return null;
  }
}

const failed = [];
const agent = fixture.makeAgent();
const exec = (target = agent) => ({ signal: new AbortController().signal, agent: target });
const modelText = (tool, args, value) => tool.output.render(args, value).map((block) => block.text ?? "").join("\n");

await fixture.preStep({ agent, signal: { throwIfAborted() {} } }, async () => ({ kind: "enter", messages: [] }));

const mcpLoad = fixture.tool("mcp_load");
const mcpCall = fixture.tool("mcp_call");
if (!mcpLoad || !mcpCall) failed.push("mcp_load/mcp_call definitions missing");
else {
  await mcpLoad.execute({ name: "demo" }, exec());

  // 1. well-shaped calls still work
  const echoArgs = { name: "demo", tool: "echo", args: { msg: "hi" } };
  const echoed = modelText(mcpCall, echoArgs, await mcpCall.execute(echoArgs, exec()));
  if (!echoed.includes("called echo") || !echoed.includes("hi")) failed.push(`well-shaped bridge call regressed: ${echoed}`);
  const noArgCall = { name: "demo", tool: "noargs" };
  const noargs = modelText(mcpCall, noArgCall, await mcpCall.execute(noArgCall, exec()));
  if (!noargs.includes("called noargs")) failed.push(`omitted-args bridge call regressed: ${noargs}`);

  // 2. malformed shapes are rejected with the correct shape, no auto-unwrap
  failed.push(await expectError(
    mcpCall.execute({ name: "demo", args: { tool: "echo", args: { msg: "hi" } } }, exec()),
    [/nested inside "args"/, /TOP-LEVEL/],
    "nested shape",
  ));
  failed.push(await expectError(
    mcpCall.execute({ name: "demo" }, exec()),
    [/requires a top-level "tool" string field/],
    "missing tool",
  ));
  failed.push(await expectError(
    mcpCall.execute({ name: "demo", tool: "echo", args: "oops" }, exec()),
    [/"args" must be an object/],
    "non-object args",
  ));

  // 3. server-side JSON-RPC failure carries the call context
  failed.push(await expectError(
    mcpCall.execute({ name: "demo", tool: "fail", args: { x: 1 } }, exec()),
    [/called MCP tool: demo\/fail/, /arguments sent: \{"x":1\}/, /tool inputSchema: \{/],
    "bridge error context",
  ));

  // 3'. isError tool results carry the same context
  failed.push(await expectError(
    mcpCall.execute({ name: "demo", tool: "softfail", args: { q: 9 } }, exec()),
    [/soft failure: bad thing happened/, /called MCP tool: demo\/softfail/, /arguments sent: \{"q":9\}/],
    "bridge isError context",
  ));

  // 4. a native-tier row is not callable through the bridge
  failed.push(await expectError(
    mcpCall.execute({ name: "nativebridge", tool: "echo", args: { msg: "x" } }, exec()),
    [/native tier/],
    "native row through the bridge",
  ));
}

await fixture.cleanup();

const realFailures = failed.filter((item) => item !== null);
if (realFailures.length > 0) {
  for (const item of realFailures) console.log("FAIL:", item);
  console.log("MCP CALL GUARD SMOKE FAILED");
  process.exit(1);
}
console.log("MCP CALL GUARD SMOKE PASSED");
