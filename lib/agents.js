// dsh-skill-mcp-manager — per-profile agent state.
//
// v2 keeps NO configuration of its own: a server's definition lives in the
// profile's patch layers. This file is the only plugin-private state, and it
// stores just the things the patch cannot express:
//
//   rows[rowId]      — the row is proxied BY THIS PLUGIN (tier "on-demand"):
//                      the native dsh-mcp-client is held off by a `disabled`
//                      override and the bridge in lib/index.js launches the
//                      server itself. Holds per-tool switches (false = hidden).
//   snapshots[rowId] — cached server metadata + tool list, refreshed by
//                      mcp_register / mcp_load / the UI's snapshot button so
//                      descriptions survive restarts without connecting.
//   notes[rowId]     — free-text note; display-only.
//
// Everything else (enabled/disabled, transport, command, env) is read back
// from the patch on every use, so hand-editing the patch never desynchronizes
// the plugin: an override removed by hand simply turns the row native again.

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

function agentsFileOf(dataDir, profileName) {
  const safe = typeof profileName === "string" && /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/.test(profileName)
    ? profileName
    : "web";
  return join(dataDir, `agents.${safe}.json`);
}

export function emptyAgents() {
  return { version: 1, rows: {}, snapshots: {}, notes: {} };
}

export async function loadAgents(dataDir, profileName) {
  try {
    const text = await readFile(agentsFileOf(dataDir, profileName), "utf8");
    const data = JSON.parse(text);
    if (data === null || typeof data !== "object") throw new Error("invalid shape");
    return {
      version: 1,
      rows: data.rows !== null && typeof data.rows === "object" && !Array.isArray(data.rows) ? data.rows : {},
      snapshots: data.snapshots !== null && typeof data.snapshots === "object" && !Array.isArray(data.snapshots) ? data.snapshots : {},
      notes: data.notes !== null && typeof data.notes === "object" && !Array.isArray(data.notes) ? data.notes : {},
    };
  } catch (error) {
    if (error && error.code === "ENOENT") return emptyAgents();
    throw error;
  }
}

export async function saveAgents(dataDir, profileName, state) {
  await mkdir(dataDir, { recursive: true });
  const file = agentsFileOf(dataDir, profileName);
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}
