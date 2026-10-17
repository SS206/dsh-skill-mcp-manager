// Skill-scope smoke test: the SKILL drawer reads the agent-preset layer.
//
// The built-in dsh-skill-filesystem is mounted by the agent preset, so list/get
// must carry that preset's standing scope. The API for it changed:
//   - 0.1.x        -> agentPresets.standingKeyFor()
//   - 0.2.0-rc.2+  -> agentPresets.acquireScope(id) => { key, [Symbol.asyncDispose] },
//                     valid only while the lease is held.
// A host without either API must still answer with the global layer.

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const dataRoot = join(homedir(), ".dsh-skill-scope-smoke-" + process.pid);
await rm(dataRoot, { recursive: true, force: true });
await mkdir(dataRoot, { recursive: true });

const PRESET_KEY = { kind: "preset-standing-key" };
const SKILL = {
  name: "docx",
  description: "Word documents",
  path: "C:/Users/example/.agents/skills/docx/SKILL.md",
  source: "user-agents",
  provider: "filesystem",
  invocation: { modelInvocable: true, userInvocable: true },
};

const failed = [];

async function runCase(label, presetFactory) {
  const dataDir = join(dataRoot, label);
  await mkdir(dataDir, { recursive: true });
  const routes = [];
  const observed = { list: [], get: [] };
  const state = { leaseDisposedAtGet: null };

  const ctx = {
    tools: { register() { return () => {}; } },
    skills: {
      registerProvider() { return () => {}; },
      async list(options = {}) {
        observed.list.push(options);
        return options.scope === PRESET_KEY
          ? [{ name: SKILL.name, description: SKILL.description, invocation: SKILL.invocation, source: SKILL.source, provider: SKILL.provider }]
          : [];
      },
      async get(name, options = {}) {
        observed.get.push(options);
        state.leaseDisposedAtGet = state.lease?.disposed ?? null;
        return name === SKILL.name && options.scope === PRESET_KEY ? SKILL : undefined;
      },
    },
    on() { return () => {}; },
    effect() { return () => {}; },
    get(name) {
      if (name === "webServer") return { register(route) { routes.push(route); return () => {}; } };
      if (name === "agentPresets") return presetFactory(state);
      return undefined;
    },
    logger: { warn() {}, error() {}, info() {} },
  };

  const { apply } = await import("../lib/index.js");
  await apply(ctx, { dataDir, profile: "__test__", importNativeMcp: false });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const route = routes.find((item) => item.path === "/skill-mcp-manager/skills");
  const res = { status: 0, body: "" };
  res.writeHead = (status) => { res.status = status; };
  res.end = (chunk) => { res.body = chunk; };
  await route.handler({
    method: "GET",
    url: "/skill-mcp-manager/skills",
    headers: { origin: "http://127.0.0.1:7404", host: "127.0.0.1:7404" },
    [Symbol.asyncIterator]() { return { async next() { return { done: true }; } }; },
  }, res);
  const body = res.body ? JSON.parse(res.body) : {};
  return { status: res.status, skills: body.skills || [], observed, state };
}

// 1) 0.1.x: standingKeyFor() is the scope source.
{
  const result = await runCase("standing", () => ({ standingKeyFor: async () => PRESET_KEY }));
  console.log("standingKeyFor ->", result.status, result.skills.map((skill) => skill.name).join(","));
  if (result.status !== 200) failed.push("standingKeyFor case: status != 200");
  if (result.observed.list[0]?.scope !== PRESET_KEY) failed.push("standingKeyFor case: list did not receive the standing key");
  if (result.observed.get[0]?.scope !== PRESET_KEY) failed.push("standingKeyFor case: get did not receive the standing key");
  if (result.skills.length !== 1 || result.skills[0].name !== "docx") failed.push("standingKeyFor case: the scoped skill was not listed");
}

// 2) 0.2.0-rc.2: acquireScope(id) lease covers the whole read.
{
  const calls = { ids: [], disposed: 0 };
  const result = await runCase("acquire", (state) => ({
    config: { default: "standard", selectedDefault: "standard" },
    async acquireScope(id) {
      calls.ids.push(id);
      const lease = {
        key: PRESET_KEY,
        disposed: false,
        async [Symbol.asyncDispose]() { lease.disposed = true; calls.disposed += 1; },
      };
      state.lease = lease;
      return lease;
    },
  }));
  console.log("acquireScope ->", result.status, result.skills.map((skill) => skill.name).join(","), "ids:", calls.ids.join(","), "disposed:", calls.disposed);
  if (result.status !== 200) failed.push("acquireScope case: status != 200");
  if (calls.ids.join(",") !== "standard") failed.push("acquireScope should be called with the selected default preset, got " + calls.ids.join(","));
  if (result.observed.list[0]?.scope !== PRESET_KEY) failed.push("acquireScope case: list did not receive the lease key");
  if (result.observed.get[0]?.scope !== PRESET_KEY) failed.push("acquireScope case: get did not receive the lease key");
  if (result.state.leaseDisposedAtGet !== false) failed.push("the lease must still be held while the definitions are read");
  if (calls.disposed !== 1) failed.push("the lease must be released exactly once, got " + calls.disposed);
  if (result.skills.length !== 1) failed.push("acquireScope case: the scoped skill was not listed");
}

// 3) No preset API: the global layer still answers (never a hard failure).
{
  const result = await runCase("none", () => ({}));
  console.log("no preset api ->", result.status, "skills:", result.skills.length);
  if (result.status !== 200) failed.push("no-API case: status != 200");
  if ("scope" in (result.observed.list[0] || {})) failed.push("no-API case: list must be called without a scope");
}

// 4) A broken acquireScope degrades to the global layer instead of failing.
{
  const result = await runCase("broken", () => ({ acquireScope: async () => { throw new Error("preset unavailable"); } }));
  console.log("broken acquireScope ->", result.status, "skills:", result.skills.length);
  if (result.status !== 200) failed.push("broken acquireScope case: status != 200");
  if ("scope" in (result.observed.list[0] || {})) failed.push("broken acquireScope case: list must fall back to no scope");
}

// 5) A broken standingKeyFor degrades the same way.
{
  const result = await runCase("broken-old", () => ({ standingKeyFor: async () => { throw new Error("no standing mount"); } }));
  console.log("broken standingKeyFor ->", result.status, "skills:", result.skills.length);
  if (result.status !== 200) failed.push("broken standingKeyFor case: status != 200");
}

await rm(dataRoot, { recursive: true, force: true });

if (failed.length > 0) {
  for (const message of failed) console.error("FAIL:", message);
  process.exit(1);
}
console.log("SKILL SCOPE SMOKE PASSED");
