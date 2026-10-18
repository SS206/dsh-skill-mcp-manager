// mcp-catalog pre-step (v2): inject once while the catalog is on the session
// surface; re-append after compaction removes it, when the stored text is
// unreadable, when the source is not this plugin's own, or when the catalog
// content changes. Identity is the model-facing text itself, and the message
// carries the producer-owned source kind the kernel's own v3→v4 edge derives
// for an unknown plugin (`plugin:<name>`) — session format v4 refuses the
// retired bare `kind:"plugin"` + `plugin` pair at write time (2026-09-28).
// Isolated dataDir, no network, no real profile.

import { join } from "node:path";
import { bootPlugin } from "./helpers/boot.mjs";

const tmp = join(process.cwd(), `.test-catalog-${process.pid}`);

const fixture = await bootPlugin({
  tmp,
  rows: [{
    id: "mcp-demo",
    serverName: "demo",
    config: { transport: "streamable-http", url: "http://127.0.0.1:1/mcp/" },
    proxied: true,
    snapshot: {
      serverDescription: "demo MCP",
      tools: [{ name: "ping", description: "ping" }],
      fetchedAt: "2020-01-01T00:00:00.000Z",
    },
  }],
});

const CATALOG_SOURCE = { kind: "plugin:dsh-skill-mcp-manager" };
const failed = [];
const signal = { throwIfAborted() {} };
const enter = async () => ({ kind: "enter", messages: [] });

// Durable-log mock shaped like the real host Session.
function makeSession() {
  const events = [];
  const surface = { nodes: [] };
  const agent = {
    session: {
      seq: 0,
      surface,
      eventAt(index) {
        if (!Number.isSafeInteger(index) || index < 0 || index >= events.length) return undefined;
        return events[index];
      },
    },
  };
  return {
    agent,
    append(event) {
      const seq = events.length;
      events.push({ seq, ...event });
      surface.nodes.push(seq);
      agent.session.seq = events.length;
    },
    compact() {
      surface.nodes.length = 0;
    },
  };
}

function isCatalog(message) {
  return message?.source?.kind === CATALOG_SOURCE.kind;
}
function catalogCount(messages) {
  return messages.filter(isCatalog).length;
}
function lastCatalog(messages) {
  return [...messages].reverse().find(isCatalog);
}
function persist(session, message) {
  session.append({ type: "user/message", data: { content: message.content, source: message.source } });
}

// 1) First step on an empty session: inject exactly once, with the exact source.
const first = makeSession();
const firstResult = await fixture.preStep({ agent: first.agent, signal }, enter);
if (catalogCount(firstResult.messages) !== 1) failed.push("first step did not inject mcp-catalog");
const injected = lastCatalog(firstResult.messages);
if (JSON.stringify(injected?.source) !== JSON.stringify(CATALOG_SOURCE)) failed.push(`injected source must be exactly ${JSON.stringify(CATALOG_SOURCE)}, got ${JSON.stringify(injected?.source)}`);
if (injected?.source?.kind === "plugin") failed.push("source kind must not be the bare \"plugin\" v4 refuses at write time");
if ("plugin" in (injected?.source ?? {})) failed.push("source must not carry the retired plugin member");
if (injected?.source?.digest !== undefined) failed.push("source must not carry a digest (migration audit refuses it)");
if ("form" in (injected?.source ?? {})) failed.push("injected catalog must not declare a form");
if (injected?.source?.entries !== undefined) failed.push("source must not carry entries");
if (typeof injected?.content?.[0]?.text !== "string" || injected.content[0].text === "") failed.push("injected catalog must carry its model-facing text");
if (!injected?.content?.[0]?.text.includes("demo")) failed.push("catalog text must list the discovered row");
persist(first, injected);

// 2) Still visible and unchanged: no re-injection, turn after turn.
for (let round = 2; round <= 4; round += 1) {
  const result = await fixture.preStep({ agent: first.agent, signal }, enter);
  if (catalogCount(result.messages) !== 0) failed.push(`round ${round} re-injected the visible catalog`);
}

// 3) Compaction empties the surface: the catalog must be re-appended.
first.compact();
const compacted = await fixture.preStep({ agent: first.agent, signal }, enter);
if (catalogCount(compacted.messages) !== 1) failed.push("compaction did not re-inject mcp-catalog");
persist(first, lastCatalog(compacted.messages));

// 4) A record with this plugin's source but no readable text does not count.
const shapeless = makeSession();
shapeless.append({ type: "user/message", data: { source: CATALOG_SOURCE } });
const afterShapeless = await fixture.preStep({ agent: shapeless.agent, signal }, enter);
if (catalogCount(afterShapeless.messages) !== 1) failed.push("a catalog record without readable text must not count as visible");

// 5) Somebody else's source must not suppress the injection.
const foreign = makeSession();
foreign.append({ type: "user/message", data: { source: { kind: "skill-catalog" }, content: lastCatalog(firstResult.messages).content } });
const afterForeign = await fixture.preStep({ agent: foreign.agent, signal }, enter);
if (catalogCount(afterForeign.messages) !== 1) failed.push("a foreign plugin source must not count as this plugin's catalog");

// 6) A repaired historical catalog (same text, this kind) must count.
const repaired = makeSession();
repaired.append({ type: "user/message", data: { source: CATALOG_SOURCE, content: lastCatalog(firstResult.messages).content } });
const afterRepaired = await fixture.preStep({ agent: repaired.agent, signal }, enter);
if (catalogCount(afterRepaired.messages) !== 0) failed.push("a repaired historical catalog must count as visible");

// 7) Row state changes while the catalog is visible: the text changes, so a
//    fresh copy is appended (a per-tool switch drops the tool from the list).
const changed = makeSession();
const before = await fixture.preStep({ agent: changed.agent, signal }, enter);
if (catalogCount(before.messages) !== 1) failed.push("content-change scenario: first injection missing");
persist(changed, lastCatalog(before.messages));
const off = await fixture.callRoute("/skill-mcp-manager/mcp/tool-tier", "POST", { rowId: "mcp-demo", tool: "ping", enabled: false });
if (off.status !== 200) failed.push(`tool switch failed: ${off.json?.error ?? off.status}`);
const after = await fixture.preStep({ agent: changed.agent, signal }, enter);
if (catalogCount(after.messages) !== 1) failed.push("text change while visible did not re-inject");
if (lastCatalog(after.messages).content[0].text === lastCatalog(before.messages).content[0].text) {
  failed.push("catalog text did not change after the tool switch");
}

await fixture.cleanup();

if (failed.length > 0) {
  for (const item of failed) console.log("FAIL:", item);
  console.log("CATALOG SMOKE FAILED");
  process.exit(1);
}
console.log("CATALOG SMOKE PASSED");
