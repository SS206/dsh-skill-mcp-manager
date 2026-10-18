// Cross-profile inventory view (v2): the page can display ANY profile's MCP
// rows — its user layer plus every bundle layer — discovered statically. Only
// the booted profile is writable; switching the view is a display preference
// (settings.viewProfile) with no takeover and no handover.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bootPlugin, patchFor } from "./helpers/boot.mjs";

const tmp = join(process.cwd(), `.test-profile-view-${process.pid}`);

const fixture = await bootPlugin({
  tmp,
  rows: [
    {
      id: "mcp-codegraph",
      serverName: "codegraph",
      config: { transport: "stdio", command: "node", args: ["-e", ""] },
    },
    {
      id: "mcp-demo",
      serverName: "demo",
      config: { transport: "stdio", command: "node", args: ["-e", ""] },
      proxied: true,
      snapshot: { serverDescription: "proxied demo", tools: [{ name: "ping", description: "ping" }], fetchedAt: "2026-01-01T00:00:00.000Z" },
    },
  ],
});

// A second profile on the same machine: its own user layer plus a bundle that
// contributes a row. It is not running, so its view is static.
const webDir = join(tmp, "profiles", "web");
const bundleDir = join(webDir, "node_modules", "@local", "web-bundle");
await mkdir(bundleDir, { recursive: true });
await writeFile(join(webDir, "cordis.patch.yml"), patchFor([
  { id: "mcp-webonly", serverName: "webonly", config: { transport: "stdio", command: "node", args: ["-e", ""] } },
]), "utf8");
await writeFile(join(webDir, "package.json"), `${JSON.stringify({ name: "dsh-profile-web", private: true, dsh: { profile: { bundles: ["@local/web-bundle"] } } }, null, 2)}\n`, "utf8");
await writeFile(join(bundleDir, "package.json"), `${JSON.stringify({ name: "@local/web-bundle", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } }, null, 2)}\n`, "utf8");
await writeFile(join(bundleDir, "cordis.patch.yml"), patchFor([
  { id: "mcp-bundled", serverName: "bundled", config: { transport: "streamable-http", url: "http://127.0.0.1:1/mcp/" } },
]), "utf8");

const failed = [];
const profileState = await fixture.callRoute("/skill-mcp-manager/profile", "GET");
if (profileState.status !== 200) failed.push(`GET /profile returned ${profileState.status}`);
if (profileState.json?.booted?.name !== "__test__") failed.push(`booted profile wrong: ${JSON.stringify(profileState.json?.booted)}`);
if (profileState.json?.view !== "__test__") failed.push(`default view should follow the booted profile: ${profileState.json?.view}`);
const names = (profileState.json?.profiles ?? []).map((item) => item.name);
if (!names.includes("__test__") || !names.includes("web")) failed.push(`profiles list incomplete: ${names.join(",")}`);
if ((profileState.json?.profiles ?? []).find((item) => item.name === "__test__")?.booted !== true) failed.push("the booted profile was not flagged");

// Booted view: live, writable.
const bootedView = await fixture.callRoute("/skill-mcp-manager/inventory", "GET");
const bootedRows = new Map((bootedView.json?.rows ?? []).map((row) => [row.serverName, row]));
if (bootedView.json?.profile?.name !== "__test__") failed.push(`booted inventory profile: ${bootedView.json?.profile?.name}`);
if (bootedView.json?.profile?.writable !== true) failed.push("the booted profile should be writable");
if (bootedRows.get("codegraph")?.tier !== "native") failed.push(`codegraph tier: ${bootedRows.get("codegraph")?.tier}`);
if (bootedRows.get("codegraph")?.source !== "user") failed.push(`codegraph source: ${bootedRows.get("codegraph")?.source}`);
if (bootedRows.get("demo")?.tier !== "on-demand") failed.push(`demo tier: ${bootedRows.get("demo")?.tier}`);
if (bootedRows.get("demo")?.live?.phase !== "proxied") failed.push(`proxied phase: ${bootedRows.get("demo")?.live?.phase}`);
if (bootedRows.get("demo")?.live?.toolCount !== 1) failed.push(`proxied tool count: ${bootedRows.get("demo")?.live?.toolCount}`);
if (bootedView.json?.counts?.on !== 2) failed.push(`enabled count: ${bootedView.json?.counts?.on}`);

// Foreign view: static, read-only, and it DOES include the bundle row.
const foreign = await fixture.callRoute("/skill-mcp-manager/inventory", "GET", undefined, { url: "/skill-mcp-manager/inventory?profile=web" });
if (foreign.json?.profile?.name !== "web") failed.push(`foreign inventory profile: ${foreign.json?.profile?.name}`);
if (foreign.json?.profile?.booted !== false) failed.push("a foreign view must report booted=false");
if (foreign.json?.profile?.writable !== false) failed.push("a foreign view must be read-only");
const foreignRows = new Map((foreign.json?.rows ?? []).map((row) => [row.serverName, row]));
if (foreignRows.get("webonly")?.source !== "user") failed.push(`webonly source: ${foreignRows.get("webonly")?.source}`);
if (foreignRows.get("bundled")?.source !== "bundle") failed.push(`the bundle-provided row was not discovered: ${[...foreignRows.keys()].join(",")}`);
if (foreignRows.get("bundled")?.bundle !== "@local/web-bundle") failed.push(`bundle attribution wrong: ${foreignRows.get("bundled")?.bundle}`);
if (foreignRows.get("bundled")?.live?.phase !== null) failed.push("a foreign profile must not report live phases");
if (foreignRows.get("demo") !== undefined) failed.push("a foreign view leaked the booted profile's rows");

// Writes against a foreign row are refused.
const foreignWrite = await fixture.callRoute("/skill-mcp-manager/mcp/tier", "POST", { rowId: "mcp-webonly", tier: "off" });
if (foreignWrite.status === 200) failed.push("a foreign profile's row was writable");

// Switching the view: settings only, no patch rewriting.
const switched = await fixture.callRoute("/skill-mcp-manager/profile", "POST", { name: "web" });
if (switched.status !== 200) failed.push(`view switch failed: ${switched.json?.error ?? switched.status}`);
if (switched.json?.view !== "web") failed.push(`view switch reported: ${switched.json?.view}`);
const settings = await fixture.readSettings();
if (settings?.viewProfile !== "web") failed.push(`viewProfile was not persisted: ${JSON.stringify(settings)}`);
const webPatch = await fixture.lib ? null : null;
const nowForeign = await fixture.callRoute("/skill-mcp-manager/inventory", "GET");
if (nowForeign.json?.profile?.name !== "web") failed.push(`the default view did not follow the setting: ${nowForeign.json?.profile?.name}`);

// The booted profile's patch is untouched by a view change.
const patchAfter = await fixture.readPatch();
if (patchAfter.includes("webonly")) failed.push("a view switch wrote the foreign profile's rows into the booted patch");

// Switching back follows the booted profile again.
const back = await fixture.callRoute("/skill-mcp-manager/profile", "POST", { name: "" });
if (back.json?.view !== "__test__") failed.push(`switching back reported: ${back.json?.view}`);
const cleared = await fixture.readSettings();
if (cleared?.viewProfile !== undefined) failed.push(`viewProfile was not cleared: ${JSON.stringify(cleared)}`);

// An unknown profile is refused.
const unknown = await fixture.callRoute("/skill-mcp-manager/profile", "POST", { name: "nope" });
if (unknown.status === 200) failed.push("an unknown profile was accepted");

// The booted profile's own writes still work while viewing it.
const tierWrite = await fixture.callRoute("/skill-mcp-manager/mcp/tier", "POST", { rowId: "mcp-demo", tier: "off" });
if (tierWrite.status !== 200) failed.push(`booted row write failed: ${tierWrite.json?.error ?? tierWrite.status}`);

await fixture.cleanup();

if (failed.length > 0) {
  for (const item of failed) console.log("FAIL:", item);
  console.log("PROFILE VIEW SMOKE FAILED");
  process.exit(1);
}
console.log("PROFILE VIEW SMOKE PASSED");
