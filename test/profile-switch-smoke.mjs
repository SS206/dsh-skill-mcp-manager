// Profile-switch smoke test: boot the plugin against a temp DSH_HOME with two
// profiles (desktop booted, web installed-but-not-booted), then drive
// /skill-mcp-manager/profile directly.
//
// Verifies the switch contract:
//   1. the booted profile is taken over at startup (its registry file is
//      registry.desktop.json, its native rows move into the managed block);
//   2. switching to web hands desktop back byte-for-byte (rows enabled again,
//      no managed span) and adopts web (its rows disabled inside the block);
//   3. each profile keeps its own registry file — switching never merges them;
//   4. switching back re-adopts desktop from the patch it just restored;
//   5. unknown/invalid targets fail without touching a single patch.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const tmp = join(homedir(), ".dsh-profile-switch-smoke-" + process.pid);
const dataDir = join(tmp, "data");
const desktopDir = join(tmp, "profiles", "desktop");
const webDir = join(tmp, "profiles", "web");
await rm(tmp, { recursive: true, force: true });
for (const dir of [dataDir, desktopDir, webDir, join(webDir, "node_modules", "dsh-skill-mcp-manager")]) {
  await mkdir(dir, { recursive: true });
}

const desktopNative = [
  "# desktop native section — must survive byte-for-byte",
  "- insert:",
  "    - id: mcp-codegraph",
  "      name: '@deepseek-ai/dsh-mcp-client'",
  "      config:",
  "        serverName: codegraph",
  "        transport: stdio",
  "        command: node",
  "        args: ['-e', '']",
  "        toolCallTimeoutMs: 120000",
].join("\n") + "\n";
const webNative = [
  "# web native section — must survive byte-for-byte",
  "- insert:",
  "    - id: mcp-tavily",
  "      name: '@deepseek-ai/dsh-mcp-client'",
  "      config:",
  "        serverName: tavily",
  "        transport: streamable-http",
  "        url: !!js \"'http://127.0.0.1:1/mcp/'\"",
  "        headers:",
  "          Authorization: !!js \"process.env.TAVILY_KEY || ''\"",
  "        toolCallTimeoutMs: 120000",
  "    - id: mcp-off",
  "      name: '@deepseek-ai/dsh-mcp-client'",
  "      config:",
  "        serverName: off-server",
  "        transport: stdio",
  "        command: node",
  "        args: ['-e', '']",
  "      disabled: true",
].join("\n") + "\n";
await writeFile(join(desktopDir, "cordis.patch.yml"), desktopNative, "utf8");
await writeFile(join(webDir, "cordis.patch.yml"), webNative, "utf8");
await writeFile(join(webDir, "node_modules", "dsh-skill-mcp-manager", "package.json"), "{}\n", "utf8");

process.env.DSH_HOME = tmp;
const { apply } = await import("../lib/index.js");

const routes = [];
const commands = [];
const profileContext = {
  name: "desktop",
  dir: desktopDir,
  patchPath: join(desktopDir, "cordis.patch.yml"),
};
const ctx = {
  tools: { register() { return () => {}; } },
  skills: { registerProvider() { return () => {}; } },
  on() { return () => {}; },
  effect() { return () => {}; },
  get(name) {
    if (name === "webServer") {
      return { register(route) { routes.push(route); return () => {}; } };
    }
    if (name === "commands") {
      return { register(definition) { commands.push(definition); return () => {}; } };
    }
    if (name === "profileContext") return profileContext;
    return undefined;
  },
  logger: { warn() {}, error() {}, info() {} },
};

function makeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  let index = 0;
  return {
    method,
    url,
    headers: { origin: "http://127.0.0.1:7404", host: "127.0.0.1:7404" },
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return index < chunks.length ? { value: chunks[index++], done: false } : { done: true };
        },
      };
    },
  };
}

function makeRes() {
  const res = { status: 0, body: "" };
  res.writeHead = (status) => { res.status = status; };
  res.end = (chunk) => { res.body = chunk; };
  return res;
}

const failed = [];
const bodyOf = (res) => (res.body ? JSON.parse(res.body) : {});
const profileRoute = () => routes.find((route) => route.path === "/skill-mcp-manager/profile");
const mcpRoute = () => routes.find((route) => route.path === "/skill-mcp-manager/mcp");

async function get(path) {
  const res = makeRes();
  await routes.find((route) => route.path === path).handler(makeReq("GET", path), res);
  return { status: res.status, body: bodyOf(res) };
}

async function postProfile(name) {
  const res = makeRes();
  await profileRoute().handler(makeReq("POST", "/skill-mcp-manager/profile", { name }), res);
  return { status: res.status, body: bodyOf(res) };
}

const readPatch = (dir) => readFile(join(dir, "cordis.patch.yml"), "utf8");
// One row's text, so a flag can be asserted on that row alone.
const rowOf = (text, id, nextId) => {
  const start = text.indexOf("- id: " + id);
  if (start < 0) return "";
  const end = text.indexOf("- id: " + nextId, start);
  return text.slice(start, end < 0 ? undefined : end);
};
const readJson = async (file) => JSON.parse(await readFile(join(dataDir, file), "utf8"));
const hasManaged = (text) => text.includes("# ── Managed MCP servers (dsh-skill-mcp-manager");
const rowCount = (text) => (text.match(/name: ['"]?@deepseek-ai\/dsh-mcp-client['"]?/g) || []).length;

await apply(ctx, { dataDir, importNativeMcp: true, trialTimeoutMs: 400 });
await new Promise((resolve) => setTimeout(resolve, 300));

// 1) Startup follows profileContext, not argv (there is no --profile here).
{
  const snapshot = await get("/skill-mcp-manager/profile");
  console.log("startup target:", snapshot.body.target?.name, snapshot.body.target?.source, "| registry:", snapshot.body.target?.registryFile);
  if (snapshot.status !== 200) failed.push("GET /profile status != 200");
  if (snapshot.body.target?.name !== "desktop") failed.push("startup target should be desktop, got " + snapshot.body.target?.name);
  if (snapshot.body.target?.source !== "context") failed.push("startup source should be context");
  if (snapshot.body.target?.isBooted !== true) failed.push("desktop should be flagged booted");
  if (snapshot.body.target?.registryFile !== "registry.desktop.json") failed.push("registry file should be per profile");
  const names = (snapshot.body.profiles || []).map((item) => item.name);
  if (names.join(",") !== "desktop,web") failed.push("profiles should list desktop (booted first) and web, got " + names.join(","));
  const web = (snapshot.body.profiles || []).find((item) => item.name === "web");
  if (web?.pluginInstalled !== true) failed.push("web should be flagged as having the plugin installed");

  const desktopPatch = await readPatch(desktopDir);
  if (!hasManaged(desktopPatch)) failed.push("desktop patch should carry the managed block after startup");
  if (desktopPatch.slice(0, desktopPatch.indexOf("# ── Managed MCP servers")).includes("@deepseek-ai/dsh-mcp-client")) {
    failed.push("desktop native row must not survive outside the managed block");
  }
  const desktopRegistry = await readJson("registry.desktop.json");
  console.log("desktop registry:", desktopRegistry.entries.map((entry) => entry.name + "[" + entry.tier + "]").join(", "));
  if (desktopRegistry.entries.length !== 1 || desktopRegistry.entries[0].name !== "codegraph") {
    failed.push("desktop registry should hold exactly the adopted codegraph entry");
  }
  if (desktopRegistry.entries[0].rawDisabled !== false) failed.push("rawDisabled should record the native row flag");
  const webPatchBefore = await readPatch(webDir);
  if (webPatchBefore !== webNative) failed.push("web patch must be untouched while desktop is managed");
}

// 2) Switch to web.
{
  const switched = await postProfile("web");
  console.log("switch ->", switched.status, JSON.stringify(switched.body.switched), switched.body.previous, "imported", switched.body.imported);
  if (switched.status !== 200 || switched.body.switched !== true) failed.push("switching to web should succeed");
  if (switched.body.previous !== "desktop") failed.push("previous target should be desktop");
  if (switched.body.imported !== 2) failed.push("web should import 2 entries, got " + switched.body.imported);
  if (switched.body.target?.name !== "web") failed.push("target after switch should be web");

  const desktopPatch = await readPatch(desktopDir);
  if (hasManaged(desktopPatch)) failed.push("desktop patch must lose the managed block on handover");
  if (!desktopPatch.includes("# desktop native section — must survive byte-for-byte")) failed.push("desktop comment lost on handover");
  if (rowCount(desktopPatch) !== 1) failed.push("desktop should keep exactly its restored native row");
  if (!/serverName: codegraph/.test(desktopPatch)) failed.push("restored desktop row lost its serverName");
  if (/disabled: true/.test(desktopPatch)) failed.push("restored desktop row must be enabled again");
  if (!desktopPatch.includes("toolCallTimeoutMs: 120000")) failed.push("restored desktop row lost raw config fields");

  const webPatch = await readPatch(webDir);
  if (!hasManaged(webPatch)) failed.push("web patch should carry the managed block after the switch");
  if (webPatch.slice(0, webPatch.indexOf("# ── Managed MCP servers")).includes("@deepseek-ai/dsh-mcp-client")) {
    failed.push("web native rows must not survive outside the managed block");
  }
  if (rowCount(webPatch) !== 2) failed.push("web should own exactly 2 rows after adoption");
  const managedPart = webPatch.slice(webPatch.indexOf("# ── Managed MCP servers"));
  if (!/off-server[\s\S]*disabled: true/.test(managedPart)) failed.push("an originally disabled row must stay disabled in the block");
  // Loader expressions survive the takeover: the managed row is written from
  // the source text, not from the parsed (literal) value.
  if (!managedPart.includes("url: !!js \"'http://127.0.0.1:1/mcp/'\"")) failed.push("managed web row lost its !!js url");
  if (!managedPart.includes("Authorization: !!js \"process.env.TAVILY_KEY || ''\"")) failed.push("managed web row lost its !!js header");
  if (!rowOf(managedPart, "mcp-tavily", "mcp-off").includes("disabled: true")) failed.push("managed tavily row should be disabled");

  const webRegistry = await readJson("registry.web.json");
  console.log("web registry:", webRegistry.entries.map((entry) => entry.name + "[" + entry.tier + "]").join(", "));
  if (webRegistry.entries.length !== 2) failed.push("web registry should hold 2 entries");
  if (webRegistry.entries.find((entry) => entry.name === "off-server")?.tier !== "disabled") {
    failed.push("off-server should adopt as disabled");
  }
  const desktopRegistry = await readJson("registry.desktop.json");
  if (desktopRegistry.entries.length !== 1) failed.push("desktop registry must stay intact while web is managed");

  const settings = JSON.parse(await readFile(join(dataDir, "settings.json"), "utf8"));
  if (settings.managedProfile !== "web") failed.push("the switch must persist managedProfile=web");

  const mcp = await get("/skill-mcp-manager/mcp");
  if ((mcp.body.entries || []).length !== 2) failed.push("the live library should now serve web's 2 entries");
}

// 3) Switch back to desktop: re-adopt from the restored patch.
{
  const switched = await postProfile("desktop");
  console.log("switch back ->", switched.status, switched.body.target?.name, "imported", switched.body.imported);
  if (switched.status !== 200 || switched.body.target?.name !== "desktop") failed.push("switching back to desktop should succeed");
  const desktopPatch = await readPatch(desktopDir);
  if (!hasManaged(desktopPatch)) failed.push("desktop should be adopted again");
  if (rowCount(desktopPatch) !== 1) failed.push("desktop should hold exactly 1 row after re-adoption");
  const webPatch = await readPatch(webDir);
  if (hasManaged(webPatch)) failed.push("web must be handed back when desktop is adopted");
  if (rowCount(webPatch) !== 2) failed.push("web should keep exactly its 2 restored rows");
  if (!/serverName: off-server[\s\S]*?disabled: true/.test(webPatch)) failed.push("the originally disabled web row must stay disabled");
  // The handover restores the row verbatim: expression intact, managed flag gone.
  if (!webPatch.includes("url: !!js \"'http://127.0.0.1:1/mcp/'\"")) failed.push("handed-back web row lost its !!js url");
  if (rowOf(webPatch, "mcp-tavily", "mcp-off").includes("disabled: true")) failed.push("handed-back tavily row must be enabled again");
  const desktopRegistry = await readJson("registry.desktop.json");
  if (desktopRegistry.entries.length !== 1 || desktopRegistry.entries[0].name !== "codegraph") {
    failed.push("desktop registry should still hold only codegraph (no merge from web)");
  }
  const mcp = await get("/skill-mcp-manager/mcp");
  if ((mcp.body.entries || []).length !== 1) failed.push("the live library should be desktop's 1 entry again");
}

// 4) Unknown and invalid targets must change nothing.
{
  const desktopBefore = await readPatch(desktopDir);
  const webBefore = await readPatch(webDir);
  const unknown = await postProfile("nope");
  console.log("unknown profile ->", unknown.status, unknown.body.error);
  if (unknown.status !== 400) failed.push("an unknown profile must fail with 400");
  const invalid = await postProfile("../escape");
  if (invalid.status !== 400) failed.push("an invalid profile must fail with 400");
  if ((await readPatch(desktopDir)) !== desktopBefore) failed.push("a failed switch must not touch the desktop patch");
  if ((await readPatch(webDir)) !== webBefore) failed.push("a failed switch must not touch the web patch");
  const snapshot = await get("/skill-mcp-manager/profile");
  if (snapshot.body.target?.name !== "desktop") failed.push("a failed switch must keep the target");
}

// 5) Clearing the override falls back to the install config / context.
{
  const cleared = await postProfile("");
  const settings = JSON.parse(await readFile(join(dataDir, "settings.json"), "utf8"));
  const snapshot = await get("/skill-mcp-manager/profile");
  console.log("cleared ->", cleared.status, "choice:", JSON.stringify(snapshot.body.choice), "target:", snapshot.body.target?.name);
  if (cleared.status !== 200) failed.push("clearing the override should succeed");
  if ("managedProfile" in settings) failed.push("clearing must remove managedProfile from settings.json");
  if (snapshot.body.choice !== "") failed.push("the reported choice should be empty after clearing");
  if (snapshot.body.target?.name !== "desktop") failed.push("clearing falls back to the booted profile");
}

await rm(tmp, { recursive: true, force: true });

if (failed.length > 0) {
  for (const message of failed) console.error("FAIL:", message);
  process.exit(1);
}
console.log("PROFILE SWITCH SMOKE PASSED");
