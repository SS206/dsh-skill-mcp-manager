// Client/host contract smoke test: every `/skill-mcp-manager/...` path the
// browser half calls must exist as a route the host half registers, and the
// settings-page registrations the shell depends on must still be there. This is
// the regression guard for a front end that ships separately from the host
// process that serves it.

import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = join(here, "..", ".test-data", "client-contract-" + process.pid);
await rm(tmp, { recursive: true, force: true });
await mkdir(tmp, { recursive: true });
process.env.DSH_HOME = tmp;
const { apply } = await import("../lib/index.js");

const failed = [];
function check(condition, message) {
  if (!condition) failed.push(message);
}

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
    return undefined;
  },
  logger: { warn() {}, error() {}, info() {} },
};
await apply(ctx, { dataDir: join(tmp, "data"), profile: "__test__", importNativeMcp: false });

const client = await readFile(join(here, "..", "client", "client.js"), "utf8");

// ── every client path has a host route ─────────────────────────────────────
const used = new Set();
for (const match of client.matchAll(/"(\/skill-mcp-manager\/[A-Za-z0-9/_-]*)"/g)) used.add(match[1]);
const registered = new Set(routes.map((route) => route.path));
console.log("client paths:", [...used].sort().join(", "));
check(used.size > 0, "no client path was found in client.js");
for (const path of used) {
  check(registered.has(path), `client calls ${path}, which the host does not register`);
}
for (const needed of [
  "/skill-mcp-manager/inventory",
  "/skill-mcp-manager/row/toggle",
  "/skill-mcp-manager/row/restart",
  "/skill-mcp-manager/profile",
  "/skill-mcp-manager/settings",
]) {
  check(used.has(needed), `the client no longer calls ${needed}`);
}

// ── settings-page registrations ────────────────────────────────────────────
check(/id: "mcp-manager"/.test(client), "the MCP settings section id is missing");
check(/id: "skills-manager"/.test(client), "the skills settings section id is missing");
check(/label: "MCP 管理"/.test(client), "the MCP nav label is missing");
check(/label: "技能管理"/.test(client), "the skills nav label is missing");
check(/settings\.section/.test(client), "no settings.section registration");
check(/shell\.overlay/.test(client), "the shell.overlay notice registration disappeared");
check(!/smx-tabs/.test(client), "the tab strip was supposed to be replaced by two settings pages");
check(!/ManagerSection/.test(client), "the old combined section is still referenced");

// ── the inventory response shape the page renders ─────────────────────────
const inventoryRoute = routes.find((route) => route.path === "/skill-mcp-manager/inventory");
check(inventoryRoute !== undefined, "the inventory route is not registered");
if (inventoryRoute !== undefined) {
  const res = { status: 0, body: "" };
  res.writeHead = (status) => { res.status = status; };
  res.end = (chunk) => { res.body = chunk ?? ""; };
  await inventoryRoute.handler({
    method: "GET",
    url: "/skill-mcp-manager/inventory",
    headers: { origin: "http://127.0.0.1:7404", host: "127.0.0.1:7404" },
    [Symbol.asyncIterator]() { return { async next() { return { done: true }; } }; },
  }, res);
  const body = res.body ? JSON.parse(res.body) : {};
  check(res.status === 200, `inventory GET status ${res.status}`);
  check(Array.isArray(body.servers), "the inventory payload has no servers array");
  check(typeof body.counts === "object" && body.counts !== null, "the inventory payload has no counts");
  check(typeof body.bundleAvailable === "boolean", "the inventory payload has no bundleAvailable flag");
  check(body.target && typeof body.target.patchPath === "string", "the inventory payload has no target.patchPath");
}

await rm(tmp, { recursive: true, force: true }).catch(() => {});
if (failed.length > 0) {
  console.error("CLIENT CONTRACT SMOKE FAILED:");
  for (const message of failed) console.error(" - " + message);
  process.exit(1);
}
console.log("CLIENT CONTRACT SMOKE PASSED");
