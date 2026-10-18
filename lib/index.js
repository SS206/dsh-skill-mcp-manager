// dsh-skill-mcp-manager — host plugin for DeepSeek Harness.
//
// v2 — management without ownership. The profile's patch layers ARE the MCP
// configuration; this plugin never rewrites them into a managed block and
// never keeps a registry copy. Every dsh-mcp-client row the profile composes
// (user layer + bundle layers, any profile — see lib/rows.js) is listed, and
// per-row settings are expressed with the patch's own levers:
//   - 常驻 native   : the row loads through the native dsh-mcp-client (default;
//                     the plugin writes nothing)
//   - 按需 on-demand: a `disabled` override holds the native client off and the
//                     bridge here launches the server itself (mcp_load/mcp_call)
//   - 关闭 off      : a `disabled` override and nobody loads it
// `patchReload: live` recomposes the tree about a second after a write.
//
// Model-facing tools: mcp_register (writes a user-layer row) / mcp_load /
// mcp_call. A pre-step `mcp-catalog` injects the visible server summary
// (append-only, re-appended only when the model-facing text is no longer on
// the surface).

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { access, mkdir, readFile, writeFile, rename, readdir, unlink } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { stringify } from "yaml";
import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { ResilientStdioTransport } from "./stdio-transport.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { registerRecursiveSkillProvider, setDisableModelInvocation } from "./skill.js";
import { mountUi, configView, openWithSystemEditor, trashDirectory } from "./ui.js";
import { createAuditRunner } from "./session-audit.js";
import {
  FIBER_DISPOSED,
  loaderMcpEntries,
  schemasOf,
  toolsOfBuiltin,
  toolsOfServer,
} from "./inventory.js";
import { childEnv } from "./child-env.js";
import {
  assertProfileChoice,
  listProfiles,
  normalizeProfileChoice,
  resolveProfileTarget,
} from "./profile-target.js";
import {
  discoverRows,
  emitInsertBlock,
  parseMcpRows,
  parsePatchItem,
  readPatchText,
  removeUserRow,
  rowToEntry,
  setDisabledOverride,
  splitTopLevelPatchEntriesWithRanges,
  withDisabledFlag,
  OVERRIDE_ID_PATTERN,
} from "./rows.js";
import { emptyAgents, loadAgents, saveAgents } from "./agents.js";
import {
  createMcpResultOutput,
  finalizeMcpResultContent,
  settleMcpToolResult,
} from "./mcp-result.js";

const name = "skill-mcp-manager";
const inject = ["tools", "skills"];

function readPluginVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    if (typeof pkg.version === "string" && pkg.version !== "") return pkg.version;
  } catch {
    /* package.json unreadable — the MCP handshake still needs a string */
  }
  return "0.0.0";
}

const PLUGIN_VERSION = readPluginVersion();

// Row tiers the UI and the row routes speak. "native" = the row loads through
// the native dsh-mcp-client (no override, no proxy); "on-demand" = this
// plugin's bridge launches it; "off" = a disabled override and nobody loads
// it. The MODEL-facing vocabulary keeps the historical eager/on-demand/
// disabled words (aliasTier maps them).
const ROW_TIERS = new Set(["native", "on-demand", "off"]);
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

function aliasTier(tier) {
  if (tier === "eager" || tier === "native") return "native";
  if (tier === "disabled" || tier === "off") return "off";
  if (tier === "on-demand") return "on-demand";
  return undefined;
}

// Built-in harness services that present an MCP-shaped tool set. They are
// listed read-only in the inventory so the page accounts for every tool
// source the model can reach.
const BUILTIN_PROVIDERS = [
  { service: "computerUse", serverName: "computer-use", label: "Computer Use" },
  { service: "browserUse", serverName: "browser-use", label: "Browser Use" },
];
// Managed MCP shadow/takeover block in the profile's cordis.patch.yml.
// reconcile / prepare-uninstall replace only the span between these markers.
const MANAGED_MARKER = "# ── Managed MCP servers (dsh-skill-mcp-manager, disabled shadow entries) ──";
const MANAGED_END_MARKER = "# ── End managed MCP servers (dsh-skill-mcp-manager) ──";
// Begin of the block after prepare-uninstall hands entries back to native.
const HANDOVER_MARKER = "# ── Handed back to native dsh-mcp-client (was managed by dsh-skill-mcp-manager) ──";
// DeepSeek function-name contract: 64 chars, [A-Za-z0-9_-].
const MAX_PUBLIC_NAME_LENGTH = 64;
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
const HASH_LENGTH = 12;

const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");

const Config = z.object({
  dataDir: z.string().default(""),
  // Deprecated in v2 (kept so legacy install configs keep parsing): the plugin
  // no longer manages or takes over any profile. The booted profile is the
  // runtime; the settings' viewProfile only picks which profile's inventory
  // the page displays.
  profile: z.string().default(""),
  trialTimeoutMs: z.number().default(30000),
  toolCallTimeoutMs: z.number().default(60000),
  catalogDescriptionMaxLength: z.number().default(500),
  toolDescriptionMaxLength: z.number().default(150),
  importNativeMcp: z.boolean().default(true),
});

// ── storage ────────────────────────────────────────────────────────────────

function resolveDataDir(config) {
  const raw = config.dataDir && config.dataDir.trim() !== "" ? config.dataDir : join(DSH_HOME, "skill-mcp-manager");
  return raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
}

// ── booted profile target ───────────────────────────────────────────────────
// Resolution lives in lib/profile-target.js. The booted profile is read from
// the host (ctx.profileContext) — the only profile whose rows this plugin's
// bridge may launch. argv stays a fallback for CLI-shaped launches and hosts
// that predate the service. Resolved exactly once per apply: there is no
// "managed target" to switch any more, only a display view.
function profileContextOf(ctx) {
  try {
    const value = ctx.get("profileContext");
    return value !== null && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

function targetFor(ctx, config) {
  return resolveProfileTarget({
    // The install-config profile still locates the runtime's rows (legacy
    // pinned installs); the host's profileContext outranks it whenever present.
    configProfile: typeof config?.profile === "string" ? config.profile : "",
    profileContext: profileContextOf(ctx),
    argv: process.argv,
    dshHome: DSH_HOME,
  });
}

async function loadSettings(dataDir) {
  try {
    const text = await readFile(join(dataDir, "settings.json"), "utf8");
    const data = JSON.parse(text);
    if (data === null || typeof data !== "object" || Array.isArray(data)) return {};
    return data;
  } catch (error) {
    if (error && error.code === "ENOENT") return {};
    throw error;
  }
}

async function saveSettings(dataDir, settings) {
  await mkdir(dataDir, { recursive: true });
  const file = join(dataDir, "settings.json");
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

// Keep the newest `keep` backups named `${prefix}<timestamp>`. Older copies
// are removed. Unrelated files in the directory are left alone.
export async function pruneBackups(directory, prefix, keep = 5) {
  let names;
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  const backups = names
    .filter((item) => item.startsWith(prefix))
    .map((item) => ({ item, stamp: Number(item.slice(prefix.length)) }))
    .filter((item) => Number.isFinite(item.stamp))
    .sort((a, b) => a.stamp - b.stamp);
  const extra = backups.slice(0, Math.max(0, backups.length - keep));
  for (const item of extra) {
    try {
      await unlink(join(directory, item.item));
    } catch {
      /* a backup that already disappeared is pruned */
    }
  }
}

async function writePatch(patchPath, current, next) {
  if (next === current) return false;
  await writeFile(`${patchPath}.bak-${Date.now()}`, current, "utf8");
  await writeFile(patchPath, next, "utf8");
  await pruneBackups(dirname(patchPath), `${basename(patchPath)}.bak-`);
  return true;
}

const LOCAL_COMMAND_APPROVALS = new Set(["follow", "always-ask", "always-allow"]);

export function normalizeLanHostAllowlist(value) {
  if (!Array.isArray(value)) throw new Error("lanHostAllowlist must be an array of hostnames");
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error("lanHostAllowlist entries must be hostnames");
    const host = item.trim().toLowerCase();
    if (host === "") continue;
    if (host.length > 253 || /[\s/\\:@]/.test(host) || host.includes("..")) {
      throw new Error(`invalid LAN hostname "${item}"`);
    }
    if (!out.includes(host)) out.push(host);
  }
  return out;
}

// ── legacy managed-span helpers (one-time migration only) ─────────────────
// v1 wrote a "managed" span into the profile patch: a marker comment, a
// disabled shadow copy of every registry row, an end marker. v2 never writes
// one; these helpers exist only to FIND and dismantle that span on startup,
// restoring the rows it had absorbed. Everything else about patch parsing,
// loader-expression evaluation and `disabled` overrides lives in lib/rows.js.

function indexAfterLine(text, index) {
  const newline = text.indexOf("\n", index);
  return newline < 0 ? text.length : newline + 1;
}

// Ours (v1): a shadow `- insert:` of dsh-mcp-client rows, or a takeover row
// that is only `{ id, disabled: true }`. Anything else is kept verbatim when
// the span is dismantled.
function isManagedPatchEntry(entry) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
  const keys = Object.keys(entry);
  if (
    typeof entry.id === "string" &&
    entry.id !== "" &&
    entry.disabled === true &&
    keys.length === 2 &&
    keys.includes("id") &&
    keys.includes("disabled")
  ) {
    return true;
  }
  if (!Array.isArray(entry.insert) || entry.insert.length === 0) return false;
  if (typeof entry.id === "string" && entry.id !== "") return false;
  return entry.insert.every(
    (item) => item !== null && typeof item === "object" && item.name === "@deepseek-ai/dsh-mcp-client",
  );
}

function extractUnrecognizedMiddle(middleText) {
  const kept = [];
  for (const block of splitTopLevelPatchEntriesWithRanges(middleText).entries) {
    const parsed = parsePatchItem(block.text);
    if (parsed === undefined) {
      kept.push(block.text);
      continue;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    if (items.length > 0 && items.every(isManagedPatchEntry)) continue;
    kept.push(block.text);
  }
  return kept.join("\n");
}

function splitPatchAroundManaged(text) {
  const start = text.indexOf(MANAGED_MARKER);
  if (start < 0) {
    return { prefix: text, middle: "", relocated: "", suffix: "" };
  }
  const afterStart = indexAfterLine(text, start);
  const end = text.indexOf(MANAGED_END_MARKER, afterStart);
  let middle;
  let suffix;
  if (end >= 0) {
    middle = text.slice(afterStart, end);
    suffix = text.slice(indexAfterLine(text, end));
  } else {
    middle = text.slice(afterStart);
    suffix = "";
  }
  return {
    prefix: text.slice(0, start),
    middle,
    relocated: extractUnrecognizedMiddle(middle),
    suffix,
  };
}

function stitchPatch(prefix, block, relocated, suffix) {
  const extras = [];
  if (block && block.trim() !== "") extras.push(block.replace(/^\n+/, "").trimEnd());
  if (relocated && relocated.trim() !== "") extras.push(relocated.replace(/^\n+/, "").trimEnd());
  let next = prefix.trimEnd();
  if (extras.length > 0) next += `\n\n${extras.join("\n\n")}\n`;
  else next += "\n";
  if (suffix) {
    next += suffix;
    if (!next.endsWith("\n")) next += "\n";
  }
  return next;
}

// ── MCP client ─────────────────────────────────────────────────────────────

async function buildTransport(entry, stdioMaxBufferSizeBytes) {
  switch (entry.transport) {
    case "stdio":
      // ResilientStdioTransport: wire-compatible with the SDK transport, but an
      // oversized message is answered with a synthetic JSON-RPC error instead
      // of tearing the connection down (see lib/stdio-transport.js).
      return new ResilientStdioTransport({
        command: entry.command,
        args: entry.args ?? [],
        env: await childEnv(entry.env),
        cwd: entry.cwd || undefined,
        ...(stdioMaxBufferSizeBytes === undefined ? {} : { maxBufferSize: stdioMaxBufferSizeBytes }),
      });
    case "streamable-http":
      return new StreamableHTTPClientTransport(new URL(entry.url), {
        requestInit: { headers: entry.headers ?? {} },
      });
    default:
      throw new Error(`unsupported transport "${entry.transport}"`);
  }
}

async function connectEntry(entry, timeoutMs, stdioMaxBufferSizeBytes) {
  const client = new Client({ name, version: PLUGIN_VERSION });
  const transport = await buildTransport(entry, stdioMaxBufferSizeBytes);
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`connection to "${entry.name}" timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    await Promise.race([client.connect(transport), timeout]);
    const tools = await listTools(client);
    // Server-declared metadata from the initialize handshake (the newer spec
    // adds name/version/title/description/websiteUrl to serverInfo, plus a
    // top-level instructions string and a capabilities object). Empty when the
    // server omits them.
    const serverInfo = client.getServerVersion();
    const instructions = client.getInstructions();
    const capabilities = client.getServerCapabilities();
    return { client, transport, tools, serverInfo, instructions, capabilities };
  } catch (error) {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function listTools(client) {
  const tools = [];
  let cursor;
  do {
    const response = await client.request(
      { method: "tools/list", ...(cursor === undefined ? {} : { params: { cursor } }) },
      ListToolsResultSchema,
    );
    tools.push(...response.tools);
    cursor = response.nextCursor;
  } while (cursor);
  return tools;
}

const MAX_ERROR_CONTEXT_CHARS = 2000;

// Same job as dsh-mcp-client's RawCallToolResultSchema: do not let the SDK
// reject a tools/call payload before this plugin applies the host projection.
// A zod record is not importable here; safeParse is all the SDK calls.
const RawCallToolResultSchema = {
  safeParse(data) {
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return { success: false, error: new Error("MCP tool result must be an object") };
    }
    return { success: true, data };
  },
};

function clipJson(value) {
  const text = JSON.stringify(value ?? null);
  if (text.length <= MAX_ERROR_CONTEXT_CHARS) return text;
  return `${text.slice(0, MAX_ERROR_CONTEXT_CHARS)}…(truncated, ${text.length} chars total)`;
}

// Protocol/transport-level tool-call failures (-32602, -32603, timeouts, …) are
// opaque to the model on their own. When errorInfo is provided, append the call
// context (server/tool, arguments sent, tool inputSchema) so the model can see
// what it sent and self-correct instead of guessing.
async function callTool(client, rawName, args, timeoutMs, signal, errorInfo) {
  const safeArgs = args && typeof args === "object" ? args : {};
  try {
    return await client.request(
      { method: "tools/call", params: { name: rawName, arguments: safeArgs } },
      RawCallToolResultSchema,
      { signal, timeout: timeoutMs },
    );
  } catch (err) {
    if (errorInfo === undefined) throw err;
    const lines = [
      err instanceof Error ? err.message : String(err),
      `called MCP tool: ${errorInfo.server}/${rawName}`,
      `arguments sent: ${clipJson(safeArgs)}`,
    ];
    if (errorInfo.inputSchema !== undefined) {
      lines.push(`tool inputSchema: ${clipJson(errorInfo.inputSchema)}`);
    }
    throw new Error(lines.join("\n"));
  }
}

// isError tool results are normal responses (server-side business failures,
// e.g. "unknown tool", bad parameters), not protocol rejects — attach the same
// call context so the model can see what it sent and self-correct.
function isErrorContextSuffix(errorInfo, rawName, args) {
  if (errorInfo === undefined) return "";
  return `\ncalled MCP tool: ${errorInfo.server}/${rawName}\narguments sent: ${clipJson(args && typeof args === "object" ? args : {})}`;
}

// ── naming / validation ────────────────────────────────────────────────────

function publicToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`;
  const normalized = joined.replace(INVALID_NAME_CHARS, "_");
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized;
  const hash = createHash("sha256").update(`${serverName}\0${rawName}`).digest("hex").slice(0, HASH_LENGTH);
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}

function assertServerName(value) {
  if (typeof value !== "string" || !SERVER_NAME_PATTERN.test(value)) {
    throw new Error(`invalid MCP name "${value}" (must match [A-Za-z0-9_-]{1,32})`);
  }
}

function truncate(value, maxLength) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function disabledToolNames(entry) {
  return new Set(Array.isArray(entry?.disabledTools) ? entry.disabledTools.filter((value) => typeof value === "string") : []);
}

function isToolDisabled(entry, toolName) {
  return disabledToolNames(entry).has(toolName);
}

function enabledTools(entry, tools) {
  const disabled = disabledToolNames(entry);
  return (tools ?? []).filter((tool) => !disabled.has(tool.name));
}

function connectionIdentity(entry) {
  if (entry.transport === "stdio") {
    return JSON.stringify({
      transport: "stdio",
      command: entry.command ?? null,
      args: entry.args ?? [],
      env: entry.env ?? {},
      cwd: entry.cwd ?? null,
    });
  }
  return JSON.stringify({
    transport: entry.transport ?? null,
    url: entry.url ?? null,
    headers: entry.headers ?? {},
  });
}

function registrationIdentity(entry) {
  return JSON.stringify({
    connection: connectionIdentity(entry),
    disabledTools: [...disabledToolNames(entry)].sort(),
  });
}

// A new stdio command, or a change to the program / args / env / cwd that
// will actually be executed. Tier, notes, remote URL, and an unchanged
// resubmit are not a local-command change.
export function localExecutionChange(existing, args, transport) {
  if (transport !== "stdio") return null;
  const next = {
    command: args.command !== undefined ? args.command : existing?.command ?? null,
    args: args.args !== undefined ? args.args : existing?.args ?? [],
    env: args.env !== undefined ? args.env : existing?.env ?? {},
    cwd: args.cwd !== undefined ? args.cwd : existing?.cwd ?? null,
  };
  if (existing === undefined || existing.transport !== "stdio") return { kind: "add", ...next };
  const same = (existing.command ?? null) === next.command
    && JSON.stringify(existing.args ?? []) === JSON.stringify(next.args)
    && JSON.stringify(existing.env ?? {}) === JSON.stringify(next.env)
    && (existing.cwd ?? null) === next.cwd;
  if (same) return null;
  return { kind: "change", ...next };
}

function localExecutionReason(change) {
  const lines = [
    change.kind === "add"
      ? "将新登记一个本地程序。保存之后，开机预热和每个会话都可能再次启动它。"
      : "将修改一个本地程序。保存之后，开机预热和每个会话都可能再次启动它。",
    `程序：${change.command}`,
    `参数：${JSON.stringify(change.args ?? [])}`,
  ];
  if (change.cwd) lines.push(`工作目录：${change.cwd}`);
  const envKeys = Object.keys(change.env ?? {});
  if (envKeys.length > 0) lines.push(`环境变量名：${envKeys.join(", ")}`);
  return lines.join("\n");
}

// ── entry construction ─────────────────────────────────────────────────────


// ── model-facing output ────────────────────────────────────────────────────
// Management tools stay text. MCP tool results use the host client's contract
// (raw content + text projection + image admission) from lib/mcp-result.js.

const TEXT_OUTPUT = {
  schema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  render: (_args, value) => [{ type: "text", text: value.text }],
};

// ── apply ──────────────────────────────────────────────────────────────────

async function apply(ctx, config = {}) {
  const dataDir = resolveDataDir(config);
  const trialTimeoutMs = config.trialTimeoutMs ?? 30000;
  const toolCallTimeoutMs = config.toolCallTimeoutMs ?? 60000;
  const catalogDescriptionMaxLength = config.catalogDescriptionMaxLength ?? 500;
  let toolDescriptionMaxLength = config.toolDescriptionMaxLength ?? 150;
  let localCommandApproval = "follow";
  let lanHostAllowlist = [];
  // stdio read-buffer limit for MCP connections, in MB. null = unset = the
  // SDK default (10 MiB). No extra ceiling is enforced on top of the SDK's
  // own semantics; see lib/stdio-transport.js for the oversized-message path.
  let stdioMaxBufferSizeMb = null;
  let stdioMaxBufferSizeBytes = undefined;
  function applyStdioMaxBufferSizeSetting(value) {
    stdioMaxBufferSizeMb = typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
    stdioMaxBufferSizeBytes = stdioMaxBufferSizeMb === null ? undefined : stdioMaxBufferSizeMb * 1048576;
  }

  // Live runtime state: one MCP instance set per DSH agent/session.
  const liveSessions = new Set();
  // The profile THIS process booted — the only profile whose rows the bridge
  // may launch. Authoritative from ctx.profileContext (never guessed). v2
  // target resolution does not read settings, so it can happen immediately.
  const bootedTarget = targetFor(ctx, config);
  // The per-profile agent state (proxied on-demand rows, snapshots, notes) of
  // the booted profile. Loaded once at startup and written through on change.
  let agentsState = emptyAgents();
  // settings.json contents, kept live so the settings/profile routes persist a
  // change without re-reading the file.
  let settingsState = {};
  // A short-lived cache of discovered rows for the booted profile (the pre-step
  // reads it every turn; writes invalidate it). Rows are re-read from the patch
  // files on each miss, so a hand edit converges on the next turn.
  let bootRowsCache;

  async function snapshotTools(client) {
    // Keep the server-declared inputSchema in snapshots: mcp_load renders it so
    // the model can see parameter structure before calling, and registry.json
    // persists it for peek/UI. Stripping it here silently starves the renderer.
    return (await listTools(client)).map((tool) => ({ name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema }));
  }

  // Copy server-declared metadata (from the initialize handshake) onto the
  // entry. These are read-only and refresh only when we reconnect — they are
  // never overwritten by a user note or an mcp_register edit.
  function applyServerMetadata(entry, connection) {
    entry.metaFetchedAt = new Date().toISOString();
    const info = connection?.serverInfo;
    if (info && typeof info === "object") {
      if (typeof info.name === "string" && info.name !== "") entry.serverName = info.name;
      if (typeof info.version === "string" && info.version !== "") entry.serverVersion = info.version;
      if (typeof info.title === "string" && info.title !== "") entry.serverTitle = info.title;
      if (typeof info.description === "string" && info.description !== "") entry.serverDescription = info.description;
      if (typeof info.websiteUrl === "string" && info.websiteUrl !== "") entry.websiteUrl = info.websiteUrl;
    }
    if (typeof connection?.instructions === "string" && connection.instructions !== "") {
      entry.instructions = connection.instructions;
    }
    if (connection?.capabilities && typeof connection.capabilities === "object") {
      entry.capabilities = connection.capabilities;
    }
  }

  function sessionOf(agent) {
    if (agent === undefined || agent === null) throw new Error("MCP session runtime requires an agent");
    for (const session of liveSessions) {
      if (session.agent === agent) return session;
    }
    const session = {
      agent,
      connections: new Map(),
      nativeDisposers: new Map(),
      registrationKeys: new Map(),
      connectionKeys: new Map(),
    };
    liveSessions.add(session);
    const agentCtx = agent.ctx;
    if (agentCtx !== undefined && typeof agentCtx.effect === "function") {
      agentCtx.effect(() => async () => {
        liveSessions.delete(session);
        await disposeSession(session);
      });
    }
    return session;
  }

  function toolHost(session) {
    return session.agent?.ctx?.tools ?? ctx.tools;
  }

  async function ensureConnected(session, entry) {
    const existing = session.connections.get(entry.name);
    if (existing !== undefined) return existing;
    const connection = await connectEntry(entry, trialTimeoutMs, stdioMaxBufferSizeBytes);
    session.connections.set(entry.name, connection);
    applyServerMetadata(entry, connection);
    return connection;
  }

  function rememberMount(session, entry) {
    session.registrationKeys.set(entry.name, registrationIdentity(entry));
    session.connectionKeys.set(entry.name, connectionIdentity(entry));
  }

  async function disposeSessionEntry(session, entryName) {
    const connection = session.connections.get(entryName);
    session.connections.delete(entryName);
    session.registrationKeys.delete(entryName);
    session.connectionKeys.delete(entryName);
    const disposers = session.nativeDisposers.get(entryName);
    session.nativeDisposers.delete(entryName);
    if (disposers !== undefined) for (const dispose of disposers.values()) dispose();
    if (connection !== undefined) {
      try {
        await connection.client.close();
      } catch {
        /* ignore */
      }
    }
  }

  async function disposeSession(session) {
    const names = new Set([...session.connections.keys(), ...session.nativeDisposers.keys()]);
    for (const entryName of names) await disposeSessionEntry(session, entryName);
  }

  async function disposeNamedEverywhere(entryName) {
    for (const session of [...liveSessions]) await disposeSessionEntry(session, entryName);
  }

  // Keep every session's connection pool in sync with the discovered rows:
  // a connection whose row disappeared (deleted, handed back, tier changed to
  // native/off) is disposed; the on-demand bridge reconnects lazily on the
  // next mcp_load.
  async function ensureSessionRuntime(agent) {
    if (agent === undefined || agent === null) return;
    const session = sessionOf(agent);
    const rows = await bootRows();
    const names = new Set(rows.filter((row) => row.tier === "on-demand").map((row) => row.serverName));
    for (const entryName of [...session.connections.keys()]) {
      if (!names.has(entryName)) await disposeSessionEntry(session, entryName);
    }
  }

  // Patch config for one row. Adopted rows keep their raw config; a row born in
  // the old registry (mcp_register) is re-synthesized from the field model.
  function entryRowConfig(entry) {
    if (entry.rawConfig && typeof entry.rawConfig === "object") {
      return { ...entry.rawConfig, serverName: entry.name };
    }
    const config = { serverName: entry.name, toolCallTimeoutMs: 120000 };
    if (entry.transport === "stdio") {
      config.transport = "stdio";
      config.command = entry.command;
      if (Array.isArray(entry.args) && entry.args.length > 0) config.args = entry.args;
      if (entry.env !== undefined && entry.env !== null && Object.keys(entry.env).length > 0) config.env = entry.env;
      if (entry.cwd) config.cwd = entry.cwd;
    } else if (entry.transport === "streamable-http") {
      config.transport = "streamable-http";
      config.url = entry.url;
      if (entry.headers !== undefined && entry.headers !== null && Object.keys(entry.headers).length > 0) config.headers = entry.headers;
    } else {
      return null;
    }
    return config;
  }

  function entryRowId(entry) {
    return typeof entry.systemEntryId === "string" && entry.systemEntryId !== ""
      ? entry.systemEntryId
      : `mcp-${entry.name}`;
  }

  // One loader row as patch text with the row-level flag applied. Rows adopted
  // from a patch keep their original text (`!!js` and every other byte intact);
  // rows born in the registry, or rebuilt by mcp_register, come from the field
  // model. Synthesized rows mirror the layout `stringify` produces for a
  // one-row insert, minus its `- insert:` header.
  function rowTextFor(entry, disabled) {
    if (typeof entry.rawEntryText === "string" && entry.rawEntryText !== "") {
      return withDisabledFlag(entry.rawEntryText, disabled);
    }
    const config = entryRowConfig(entry);
    if (config === null) return undefined;
    const row = { id: entryRowId(entry), name: "@deepseek-ai/dsh-mcp-client", config };
    if (disabled) row.disabled = true;
    const lines = stringify([{ insert: [row] }]).replace(/\s+$/, "").split("\n");
    return lines.slice(1).join("\n");
  }

  // Profile switch: put the profile being released back exactly as it was
  // before the takeover. Rows the registry adopted from that patch (`rawConfig`)
  // are restored verbatim — original config and original disabled flag.
  // Registry-born entries (added through mcp_register while managing that
  // profile) write nothing back: their definition stays in that profile's
  // registry file and is re-adopted when the user switches back.
  function restoreBlockYaml(entries) {
    const rows = [];
    for (const entry of entries) {
      const hasText = typeof entry.rawEntryText === "string" && entry.rawEntryText !== "";
      if (!hasText && (entry.rawConfig === null || typeof entry.rawConfig !== "object")) continue;
      const rawDisabled = entry.rawDisabled === undefined ? entry.tier === "disabled" : entry.rawDisabled === true;
      const text = rowTextFor(entry, rawDisabled);
      if (text === undefined) continue;
      rows.push(text);
    }
    if (rows.length === 0) return "";
    return ["- insert:", ...rows].join("\n");
  }

  // ── one-time v1→v2 migration ──────────────────────────────────────────────
  // Dismantle the legacy managed span in a profile's patch and express every
  // old registry entry with the v2 levers. Rows v1 had absorbed are restored
  // verbatim at their original disabled flag; rows born in the registry are
  // emitted from the field model. The old tier then maps: eager → native
  // (nothing to write), on-demand → a disabled override plus an agent-state
  // record (this plugin proxies it), disabled → a disabled override. The
  // registry file is archived as .migrated-<ts>.bak, never deleted.
  async function migrateManagedProfile(target) {
    const patchPath = target.patchPath;
    let current;
    try {
      current = await readFile(patchPath, "utf8");
    } catch (error) {
      ctx.logger.warn(`skill-mcp-manager: cannot read ${patchPath} (${String(error?.message ?? error)}); migration skipped`);
      return { changed: false, restored: 0 };
    }
    const registryFile = join(dataDir, `registry.${target.name}.json`);
    let legacyEntries = [];
    let hadRegistry = false;
    try {
      const text = await readFile(registryFile, "utf8");
      const data = JSON.parse(text);
      if (Array.isArray(data?.entries)) legacyEntries = data.entries;
      hadRegistry = true;
    } catch (error) {
      if (error && error.code !== "ENOENT") {
        ctx.logger.warn(`skill-mcp-manager: legacy registry for ${target.name} unreadable; migration skipped`);
        return { changed: false, restored: 0 };
      }
    }
    if (!current.includes(MANAGED_MARKER) && !hadRegistry) return { changed: false, restored: 0 };

    // Rows v1 adopted (rawEntryText / rawConfig) go back verbatim.
    const rows = [restoreBlockYaml(legacyEntries)];
    // Registry-born rows are emitted from the field model.
    for (const entry of legacyEntries) {
      const hasText = typeof entry.rawEntryText === "string" && entry.rawEntryText !== "";
      const hasRaw = entry.rawConfig !== null && typeof entry.rawConfig === "object";
      if (hasText || hasRaw) continue;
      const text = rowTextFor(entry, entry.tier === "disabled");
      if (text !== undefined) rows.push(["- insert:", text].join("\n"));
    }
    const block = rows.filter((part) => part && part.trim() !== "").join("\n");
    const { prefix, relocated, suffix } = splitPatchAroundManaged(current);
    let next = stitchPatch(prefix, block, relocated, suffix);

    // Express the old tiers with the v2 levers.
    const agentsNext = await loadAgents(dataDir, target.name);
    let restored = 0;
    for (const entry of legacyEntries) {
      const rowId = entryRowId(entry);
      const tier = aliasTier(entry.tier) ?? "on-demand";
      if (tier === "native") {
        restored += 1;
        continue;
      }
      if (rowId !== "" && OVERRIDE_ID_PATTERN.test(rowId)) {
        next = setDisabledOverride(next, rowId, true);
      }
      if (tier === "on-demand") {
        agentsNext.rows[rowId] = { tools: Object.fromEntries((entry.disabledTools ?? []).map((name) => [name, false])) };
        if (Array.isArray(entry.tools) && entry.tools.length > 0) {
          agentsNext.snapshots[rowId] = snapshotOf(entry);
        }
      }
      restored += 1;
    }
    const changed = next !== current && (await writePatch(patchPath, current, next));
    if (changed) {
      ctx.logger.info(`skill-mcp-manager: migrated ${target.name} off the v1 managed span (${restored} row/s restored)`);
    }
    if (hadRegistry) {
      try {
        await rename(registryFile, `${registryFile}.migrated-${Date.now()}.bak`);
      } catch (error) {
        ctx.logger.warn(`skill-mcp-manager: could not archive the legacy registry: ${String(error?.message ?? error)}`);
      }
    }
    await saveAgents(dataDir, target.name, agentsNext);
    return { changed, restored };
  }

  // The snapshot fields worth persisting for one row.
  function snapshotOf(entry) {
    return {
      serverName: entry.serverName ?? "",
      serverVersion: entry.serverVersion ?? "",
      serverTitle: entry.serverTitle ?? "",
      serverDescription: entry.serverDescription ?? "",
      websiteUrl: entry.websiteUrl ?? "",
      instructions: entry.instructions ?? "",
      tools: Array.isArray(entry.tools) ? entry.tools : [],
      fetchedAt: entry.metaFetchedAt ?? new Date().toISOString(),
    };
  }

  // ── the booted profile's rows, as the bridge and the UI see them ──────────
  // discoverRows reads the patch layers; the tier is then derived: an override
  // or the row's own disabled flag means "off", an agent-state record means
  // "on-demand" (this plugin proxies it), anything else is "native" (the
  // dsh-mcp-client loads it). A record whose override was removed by hand is
  // an orphan: the row reads native again and the startup sweep deletes it.
  async function bootRowsResult() {
    if (bootRowsCache !== undefined) return bootRowsCache;
    const found = await discoverRows({ profileDir: dirname(bootedTarget.patchPath), dshHome: DSH_HOME });
    const rows = [];
    for (const row of found.rows) {
      const agent = agentsState.rows[row.rowId];
      // A proxied row carries BOTH an agent-state record and the `disabled`
      // override that holds the native client off — the record is what says
      // "the plugin runs it". A record without the override is an orphan (the
      // override was removed by hand): the row is native again.
      const orphan = agent !== undefined && !row.disabled;
      const tier = agent !== undefined && row.disabled ? "on-demand" : row.disabled ? "off" : "native";
      rows.push({
        ...row,
        tier,
        orphan,
        loaderOnly: false,
        entry: rowToEntry(row, agent, agentsState.snapshots[row.rowId]),
      });
    }
    // Rows only the live loader knows about (a `--patch` overlay, a host-owned
    // bundle, an include subtree). They are real servers of this profile and
    // must be manageable through the patch layer's override, even though no
    // insert row here defines them.
    const claimed = new Set(rows.map((row) => row.serverName));
    const userPatch = await readPatchText(bootedTarget.patchPath);
    const { overrides } = parseMcpRows(userPatch, DSH_HOME);
    for (const record of loaderRecords()) {
      if (record.serverName === "" || claimed.has(record.serverName)) continue;
      claimed.add(record.serverName);
      const rowId = record.id !== "" ? record.id : `loader-${record.serverName}`;
      const override = overrides.has(rowId) ? overrides.get(rowId) : null;
      const disabled = override === null ? record.disabled === true : override === true;
      const agent = agentsState.rows[rowId];
      const orphan = agent !== undefined && !disabled;
      const tier = agent !== undefined && disabled ? "on-demand" : disabled ? "off" : "native";
      rows.push({
        rowId,
        serverName: record.serverName,
        config: record.config ?? {},
        unevaluated: "",
        rawText: "",
        filePath: "",
        source: "bundle",
        bundle: null,
        override,
        disabled,
        tier,
        orphan,
        loaderOnly: true,
        entry: rowToEntry({ rowId, serverName: record.serverName, config: record.config ?? {} }, agent, agentsState.snapshots[rowId]),
      });
    }
    rows.sort((a, b) => a.serverName.localeCompare(b.serverName));
    bootRowsCache = { rows, duplicates: found.duplicates };
    return bootRowsCache;
  }

  async function bootRows() {
    return (await bootRowsResult()).rows;
  }

  function invalidateBootRows() {
    bootRowsCache = undefined;
  }

  async function agentRowByName(serverName) {
    const rows = await bootRows();
    return rows.find((row) => row.serverName === serverName);
  }

  async function saveAgentsState() {
    await saveAgents(dataDir, bootedTarget.name, agentsState);
  }

  // Delete agent-state records whose row no longer carries the holding
  // override (hand-edited away): the row is native again and the record would
  // lie about it.
  async function sweepOrphanAgents() {
    let changed = false;
    const rows = await bootRows();
    const byId = new Map(rows.map((row) => [row.rowId, row]));
    for (const rowId of Object.keys(agentsState.rows)) {
      const row = byId.get(rowId);
      if (row === undefined || row.orphan === true) {
        delete agentsState.rows[rowId];
        changed = true;
      }
    }
    for (const rowId of Object.keys(agentsState.snapshots)) {
      if (!byId.has(rowId)) {
        delete agentsState.snapshots[rowId];
        changed = true;
      }
    }
    if (changed) await saveAgentsState();
    return changed;
  }

  // Set one row's tier. All three tiers are patch-layer facts (plus the agent
  // record for on-demand); patchReload: live converges the loader about a
  // second later. Only the booted profile's rows are writable.
  async function setRowTier(rowId, tier) {
    if (!ROW_TIERS.has(tier)) throw new Error(`invalid tier "${tier}"`);
    const rows = await bootRows();
    const row = rows.find((candidate) => candidate.rowId === rowId);
    if (row === undefined) throw new Error(`row "${rowId}" is not in the booted profile`);
    let patchText = await readBootedPatch();
    if (tier === "native") {
      // A row the user layer owns comes back by DROPPING the override; a
      // bundle row (or one whose own text carries disabled:) cannot — the
      // layer below would hold it down, so it needs an explicit false.
      const { rows: userRows } = parseMcpRows(patchText, DSH_HOME);
      const userRow = userRows.find((candidate) => candidate.rowId === rowId);
      const selfDisabled = userRow !== undefined && /^\s*disabled\s*:/m.test(userRow.rawText ?? "");
      const dropOverride = userRow !== undefined && !selfDisabled;
      patchText = setDisabledOverride(patchText, rowId, dropOverride ? null : false);
      if (agentsState.rows[rowId] !== undefined) {
        delete agentsState.rows[rowId];
        await saveAgentsState();
      }
    } else {
      patchText = setDisabledOverride(patchText, rowId, true);
      if (tier === "on-demand") {
        if (agentsState.rows[rowId] === undefined) {
          agentsState.rows[rowId] = { tools: {} };
          await saveAgentsState();
        }
      } else if (agentsState.rows[rowId] !== undefined) {
        delete agentsState.rows[rowId];
        await saveAgentsState();
      }
    }
    const previousTier = row.tier;
    await writeBootedPatch(await readBootedPatch(), patchText);
    invalidateBootRows();
    // A row that stops being proxied must lose its bridge connections; one
    // that becomes proxied is connected lazily by the next mcp_load.
    if (previousTier === "on-demand" && tier !== "on-demand") {
      await disposeNamedEverywhere(row.serverName);
    }
    return { ok: true, rowId, tier, previousTier };
  }

  // Per-tool visibility for an on-demand (proxied) row.
  async function setRowToolEnabled(rowId, toolName, enabled) {
    if (typeof toolName !== "string" || toolName === "") throw new Error("tool name is required");
    if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
    const rows = await bootRows();
    const row = rows.find((candidate) => candidate.rowId === rowId);
    if (row === undefined) throw new Error(`row "${rowId}" is not in the booted profile`);
    if (row.tier !== "on-demand") {
      throw new Error(`row "${rowId}" is not proxied; per-tool switches need the on-demand tier`);
    }
    const snapshot = agentsState.snapshots[rowId];
    const known = Array.isArray(snapshot?.tools) ? snapshot.tools : row.entry.tools;
    if (known.length > 0 && !known.some((tool) => tool.name === toolName)) {
      throw new Error(`MCP tool "${row.serverName}/${toolName}" is not in the latest tool snapshot`);
    }
    const record = agentsState.rows[rowId];
    record.tools = record.tools ?? {};
    if (enabled) delete record.tools[toolName];
    else record.tools[toolName] = false;
    await saveAgentsState();
    invalidateBootRows();
    return { ok: true, rowId, tool: toolName, enabled };
  }

  // The booted profile may not have a patch file yet (a fresh profile, or the
  // first MCP added by hand). Reading it as empty and creating it on write is
  // what makes "add the first server" work.
  async function readBootedPatch() {
    try {
      return await readFile(bootedTarget.patchPath, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") return "";
      throw new Error(`cannot read ${bootedTarget.patchPath}: ${String(error?.message ?? error)}`);
    }
  }

  async function writeBootedPatch(current, next) {
    await mkdir(dirname(bootedTarget.patchPath), { recursive: true });
    return await writePatch(bootedTarget.patchPath, current, next);
  }

  // mcp_register: append a user-layer insert row (the durable, plugin-
  // independent home for the definition), then express the requested tier.
  async function registerRow(args, exec) {
    assertServerName(args.name);
    const tier = aliasTier(args.tier ?? "on-demand") ?? "on-demand";
    const rows = await bootRows();
    const existing = rows.find((row) => row.serverName === args.name);
    if (existing !== undefined && existing.source !== "user") {
      throw new Error(`MCP "${args.name}" is provided by bundle "${existing.bundle}" — its configuration belongs to that bundle`);
    }
    const rowId = `mcp-${args.name}`;
    if (existing !== undefined && existing.rowId !== rowId) {
      throw new Error(`row id "${existing.rowId}" already serves the name "${args.name}"`);
    }
    // An update may name only what changes (a tier or a note): the rest of the
    // definition carries over from the row being replaced.
    const previousConfig = existing !== undefined && existing.config !== null && typeof existing.config === "object"
      ? existing.config
      : {};
    const connectionTouched = args.transport !== undefined || args.command !== undefined
      || args.url !== undefined || args.args !== undefined || args.env !== undefined
      || args.cwd !== undefined || args.headers !== undefined;
    const transport = args.transport ?? previousConfig.transport ?? (args.url ? "streamable-http" : "stdio");
    const config = { serverName: args.name, transport };
    if (transport === "stdio") {
      const command = args.command ?? previousConfig.command;
      if (typeof command !== "string" || command === "") throw new Error("stdio requires a command");
      config.command = command;
      const argv = args.args ?? previousConfig.args;
      if (Array.isArray(argv) && argv.length > 0) config.args = argv.filter((item) => typeof item === "string");
      const env = args.env ?? previousConfig.env;
      if (env !== null && typeof env === "object" && !Array.isArray(env) && Object.keys(env).length > 0) config.env = env;
      const cwd = args.cwd ?? previousConfig.cwd;
      if (typeof cwd === "string" && cwd !== "") config.cwd = cwd;
    } else {
      const url = args.url ?? previousConfig.url;
      if (typeof url !== "string" || url === "") throw new Error("streamable-http requires a url");
      config.url = url;
      const headers = args.headers ?? previousConfig.headers;
      if (headers !== null && typeof headers === "object" && !Array.isArray(headers) && Object.keys(headers).length > 0) config.headers = headers;
    }
    const timeout = args.toolCallTimeoutMs ?? previousConfig.toolCallTimeoutMs;
    if (typeof timeout === "number" && Number.isInteger(timeout) && timeout > 0) {
      config.toolCallTimeoutMs = timeout;
    }

    // Update = replace the previous user-layer row (and its override) first.
    let patchText = await readBootedPatch();
    const previousEntry = existing === undefined ? undefined : rowToEntry(existing);
    if (existing !== undefined) patchText = removeUserRow(patchText, existing.rowId);
    await approveLocalExecution(exec, localExecutionChange(previousEntry, args, config.transport));

    // Trial connect for the snapshot (also validates the definition). A pure
    // metadata update (notes/tier only) keeps the previous snapshot and never
    // starts the program.
    const needsTrial = connectionTouched || existing === undefined
      || agentsState.snapshots[rowId] === undefined;
    let snapshot = agentsState.snapshots[rowId] ?? null;
    if (needsTrial) {
      const candidate = rowToEntry({ rowId, serverName: args.name, config });
      const connection = await connectEntry(candidate, trialTimeoutMs, stdioMaxBufferSizeBytes);
      try {
        const meta = { ...candidate };
        applyServerMetadata(meta, connection);
        meta.tools = await snapshotTools(connection.client);
        snapshot = snapshotOf(meta);
      } finally {
        await connection.client.close();
      }
    }

    let next = patchText.replace(/\s+$/, "");
    if (next === "[]") next = "";
    next = next === "" ? emitInsertBlock(rowId, config) : `${next}\n\n${emitInsertBlock(rowId, config).trimEnd()}\n`;
    if (tier !== "native") next = setDisabledOverride(next, rowId, true);
    await writeBootedPatch(patchText, next);

    agentsState.snapshots[rowId] = snapshot;
    if (tier === "on-demand") {
      // A re-register keeps the proxied record (and the user's per-tool
      // switches) it already had; the definition is what changed.
      agentsState.rows[rowId] = agentsState.rows[rowId] ?? { tools: {} };
    } else {
      delete agentsState.rows[rowId];
    }
    if (typeof args.notes === "string" && args.notes !== "") agentsState.notes[rowId] = args.notes;
    await saveAgentsState();
    invalidateBootRows();
    return {
      rowId,
      serverName: args.name,
      tier,
      updated: existing !== undefined,
      toolCount: Array.isArray(snapshot?.tools) ? snapshot.tools.length : 0,
    };
  }

  // Connect once to a discovered row and cache its server metadata + tool
  // list, so descriptions survive restarts without holding a connection.
  async function refreshRowSnapshot(rowId) {
    const rows = await bootRows();
    const row = rows.find((candidate) => candidate.rowId === rowId);
    if (row === undefined) throw new Error(`row "${rowId}" is not in the booted profile`);
    if (row.tier === "off") throw new Error(`row "${rowId}" is disabled; enable it first`);
    if (row.unevaluated !== "") throw new Error(`row "${rowId}" cannot be launched: ${row.unevaluated}`);
    const meta = { ...row.entry };
    const connection = await connectEntry(row.entry, trialTimeoutMs, stdioMaxBufferSizeBytes);
    try {
      applyServerMetadata(meta, connection);
      meta.tools = await snapshotTools(connection.client);
    } finally {
      try {
        await connection.client.close();
      } catch {
        /* ignore */
      }
    }
    agentsState.snapshots[rowId] = snapshotOf(meta);
    await saveAgentsState();
    invalidateBootRows();
    return { ok: true, rowId, text: renderDefinitions(row.entry, meta.tools) };
  }

  // Remove a user-layer row definition (bundle rows are refused: their
  // configuration belongs to the bundle; disable them instead).
  async function deleteRow(rowId) {
    const rows = await bootRows();
    const row = rows.find((candidate) => candidate.rowId === rowId);
    if (row === undefined) throw new Error(`row "${rowId}" is not in the booted profile`);
    if (row.source !== "user") {
      throw new Error(`row "${rowId}" is provided by bundle "${row.bundle}" — disable it instead of deleting`);
    }
    const patchText = await readBootedPatch();
    const next = setDisabledOverride(removeUserRow(patchText, rowId), rowId, null);
    await writeBootedPatch(patchText, next);
    delete agentsState.rows[rowId];
    delete agentsState.snapshots[rowId];
    delete agentsState.notes[rowId];
    await saveAgentsState();
    invalidateBootRows();
    await disposeNamedEverywhere(row.serverName);
    return { ok: true, rowId };
  }

  // prepare-uninstall: undo every trace this plugin leaves in the booted
  // profile — drop the disabled overrides it wrote (proxied/off rows load
  // natively again) and delete its agent-state file. Row definitions were
  // never ours; they stay in the patch.
  async function prepareUninstall() {
    let patchText;
    try {
      patchText = await readFile(bootedTarget.patchPath, "utf8");
    } catch {
      return { kind: "error", text: `cannot read ${bootedTarget.patchPath}` };
    }
    const rows = await bootRows();
    let next = patchText;
    let touched = 0;
    for (const row of rows) {
      if (row.override !== true && row.override !== false) continue;
      next = setDisabledOverride(next, row.rowId, null);
      touched += 1;
    }
    if (next !== patchText) await writePatch(bootedTarget.patchPath, patchText, next);
    agentsState = emptyAgents();
    await saveAgentsState();
    for (const session of [...liveSessions]) await disposeSession(session);
    return {
      kind: "success",
      text: `Removed ${touched} override(s) this plugin wrote and its agent state. Now remove the skill-mcp-manager entry from the profile's packages to finish uninstalling.`,
    };
  }

  // ── profile view (display-only) ────────────────────────────────────────────
  // Which profile's inventory the settings page shows. Not a management
  // target: the booted profile is the only one whose rows the bridge may
  // launch, and every write route refuses a foreign profile.
  function viewProfileName() {
    const choice = normalizeProfileChoice(settingsState.viewProfile);
    return choice === undefined || choice === "" ? bootedTarget.name : choice;
  }

  async function profileSnapshot() {
    // v2 has no separate managed target: the resolved target IS the runtime
    // profile, so it is what the candidate list flags as booted.
    const profiles = await listProfiles({ profilesRoot: bootedTarget.profilesRoot, bootedName: bootedTarget.name });
    return {
      booted: {
        name: bootedTarget.name,
        source: bootedTarget.source,
        patchPath: bootedTarget.patchPath,
      },
      view: viewProfileName(),
      profiles,
    };
  }

  async function setViewProfile(requested) {
    const clearing = requested === undefined || requested === null || requested === "" || requested === "booted";
    const choice = clearing ? "" : assertProfileChoice(requested);
    if (!clearing) {
      const known = await listProfiles({ profilesRoot: bootedTarget.profilesRoot, bootedName: bootedTarget.name });
      if (known.every((item) => item.name !== choice)) {
        throw new Error(`profile "${choice}" has no cordis.patch.yml or cordis.yml under ${bootedTarget.profilesRoot}`);
      }
    }
    const settings = { ...settingsState };
    if (choice === "") delete settings.viewProfile;
    else settings.viewProfile = choice;
    settingsState = settings;
    await saveSettings(dataDir, settings);
    return { ok: true, view: viewProfileName() };
  }

  function followMustAsk(agent) {
    const policy = ctx.get("sandboxPolicy");
    if (policy === undefined || typeof policy.resolve !== "function" || agent?.session === undefined) return true;
    return policy.resolve({ session: agent.session }).mode !== "danger-full-access";
  }

  // Ask before the trial connect, which is what starts the process. No
  // approval service means this host has no ask channel: keep the previous
  // silent allow. A present channel whose session policy rejects still asks;
  // anything other than allowed-once does not save and does not start.
  async function approveLocalExecution(exec, change) {
    if (localCommandApproval === "always-allow") return;
    const approval = ctx.get("approval");
    if (approval === undefined || typeof approval.request !== "function") return;
    const mustAsk = localCommandApproval === "always-ask" || followMustAsk(exec?.agent);
    if (!mustAsk) return;
    const agent = exec?.agent;
    if (agent?.session === undefined) {
      throw new Error("local command approval has no session to ask; the entry was not saved and was not started");
    }
    const outcome = await approval.request({
      agent,
      toolName: "mcp_register",
      reason: localExecutionReason(change),
      ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
      ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
    });
    if (outcome !== "allowed-once") {
      throw new Error(`local command was not approved (${outcome}); the entry was not saved and was not started`);
    }
  }

  // ── mcp_register ──
  const mcpRegister = {
    name: "mcp_register",
    description:
      "Register (add) or modify an MCP server by writing a row into the booted profile's cordis.patch.yml — the durable, plugin-independent home for the definition (a dsh-mcp-client insert row; patchReload: live loads it about a second later). Validates by trial-connecting (30s) and caches the server's declared metadata and tool list. tier: eager = the native dsh-mcp-client loads it (recommended), on-demand = this plugin proxies it (mcp_load/mcp_call, per-tool switches), disabled = written but held off. Re-registering an existing user-layer server replaces its row. Bundle-provided servers cannot be re-registered here.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Stable server name ([A-Za-z0-9_-]{1,32}); the model-facing namespace." },
        tier: { type: "string", enum: ["eager", "on-demand", "disabled"], description: "Default on-demand. eager loads natively through dsh-mcp-client." },
        transport: { type: "string", enum: ["stdio", "streamable-http"], description: "Required on add." },
        command: { type: "string", description: "stdio: executable to launch." },
        args: { type: "array", items: { type: "string" }, description: "stdio: argument array." },
        env: { type: "object", description: "stdio: extra environment (values may reference $VAR)." },
        cwd: { type: "string", description: "stdio: working directory." },
        url: { type: "string", description: "streamable-http: server URL." },
        headers: { type: "object", description: "streamable-http: extra headers." },
        toolCallTimeoutMs: { type: "number", description: "Per tools/call timeout (default 60000)." },
        notes: { type: "string", description: "Free-text note for the catalog." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const result = await registerRow(args, exec);
      const tierWord = result.tier === "native" ? "eager (native dsh-mcp-client)" : result.tier;
      return { text: `MCP "${result.serverName}" ${result.updated ? "updated" : "registered"} (row ${result.rowId}, tier ${tierWord}, ${result.toolCount} tool(s)); the patch hot-reloads in ~1s.` };
    },
  };

  // ── mcp_load ──
  const mcpLoad = {
    name: "mcp_load",
    description:
      "Load (or hot-reload) one on-demand MCP server for the current session and return its full tool definitions (names, descriptions, parameter schemas) as this tool's result. With peek=true it only reads the latest snapshot or this session's active connection without connecting. Servers at the native tier are loaded by the dsh-mcp-client directly — call their mcp__<server>__<tool> tools instead.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "MCP server name (serverName of its row)." },
        peek: { type: "boolean", description: "Default false. true = only inspect, never connect or reload." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const row = await agentRowByName(args.name);
      if (row === undefined) throw new Error(`MCP "${args.name}" is not in the booted profile's rows`);
      if (row.tier === "off") throw new Error(`MCP "${args.name}" is disabled`);
      if (row.tier === "native") throw new Error(`MCP "${args.name}" is at the native tier — call its mcp__${args.name}__<tool> tools directly`);

      if (args.peek === true) {
        const session = exec?.agent === undefined ? undefined : sessionOf(exec.agent);
        const tools = session?.connections.get(row.serverName)?.tools ?? row.entry.tools ?? [];
        return { text: renderDefinitions(row.entry, tools) };
      }

      if (exec?.agent === undefined) throw new Error("mcp_load requires a session");
      const session = sessionOf(exec.agent);
      try {
        await disposeSessionEntry(session, row.serverName);
        const connection = await ensureConnected(session, row.entry);
        const meta = { ...row.entry };
        meta.tools = await snapshotTools(connection.client);
        applyServerMetadata(meta, connection);
        agentsState.snapshots[row.rowId] = snapshotOf(meta);
        await saveAgentsState();
        invalidateBootRows();
        return { text: renderDefinitions(row.entry, meta.tools) };
      } catch (error) {
        throw error;
      }
    },
  };

  function renderDefinitions(entry, tools) {
    const visibleTools = enabledTools(entry, tools);
    const lines = [
      `MCP "${entry.name}" (${entry.tier})`,
      entry.serverDescription ? `description: ${entry.serverDescription}` : "description: (no description)",
      entry.serverName ? `serverName: ${entry.serverName}` : "",
      entry.serverVersion ? `version: ${entry.serverVersion}` : "",
      entry.serverTitle ? `title: ${entry.serverTitle}` : "",
      entry.websiteUrl ? `website: ${entry.websiteUrl}` : "",
      entry.instructions ? `instructions: ${entry.instructions}` : "",
      entry.notes ? `notes: ${entry.notes}` : "",
      "",
      "Tools:",
      ...visibleTools.map((tool) => {
        const schema = tool.inputSchema ? `\n    inputSchema: ${JSON.stringify(tool.inputSchema)}` : "";
        return `- ${tool.name}: ${tool.description ?? ""}${schema}`;
      }),
    ];
    return lines.filter((line) => line !== "").join("\n");
  }

  // ── mcp_call ──
  const mcpCallProjections = new WeakMap();
  const mcpCall = {
    name: "mcp_call",
    description:
      "Invoke one tool of an on-demand MCP server through the bridge. The server must be loaded first via mcp_load; calling an unloaded server returns an error telling you to mcp_load first. Pass structured `args` only (never shell text, never a temp file). Eager servers are called directly as mcp__<server>__<tool> instead.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Registered MCP server name." },
        tool: { type: "string", description: "Raw tool name as reported by mcp_load." },
        args: { type: "object", description: "Structured JSON arguments matching the tool's inputSchema." },
      },
      required: ["name", "tool"],
      additionalProperties: false,
    },
    output: createMcpResultOutput(undefined, (args) => args.tool),
    finalizeContent(exec, result) {
      return finalizeMcpResultContent(mcpCallProjections, exec, result);
    },
    async execute(args, exec) {
      // Parameter-shape guard: the model sometimes nests the tool call inside
      // "args" (e.g. {name, args: {tool, args}}), which previously slipped
      // through as params.name=undefined and produced an opaque server-side
      // -32602. Reject early with the correct shape; never auto-unwrap.
      if (typeof args.tool !== "string" || args.tool === "") {
        const nested =
          args.args !== null &&
          typeof args.args === "object" &&
          !Array.isArray(args.args) &&
          typeof args.args.tool === "string" &&
          args.args.tool !== "";
        throw new Error(
          nested
            ? `mcp_call parameter shape error: the tool name was nested inside "args" (args.tool="${args.args.tool}"). Correct shape: {"name":"<server name>","tool":"<raw tool name>","args":{...tool arguments...}} — "tool" is a TOP-LEVEL string field; only the tool's own arguments go inside "args". Retry with the corrected shape.`
            : `mcp_call requires a top-level "tool" string field. Correct shape: {"name":"<server name>","tool":"<raw tool name>","args":{...tool arguments...}}.`,
        );
      }
      if (args.args !== undefined && (args.args === null || typeof args.args !== "object" || Array.isArray(args.args))) {
        throw new Error(
          `mcp_call "args" must be an object holding the tool arguments (or omitted entirely for no-argument tools), got ${Array.isArray(args.args) ? "an array" : JSON.stringify(args.args)}. Correct shape: {"name":"<server name>","tool":"<raw tool name>","args":{...}}.`,
        );
      }
      const row = await agentRowByName(args.name);
      if (row === undefined) throw new Error(`MCP "${args.name}" is not in the booted profile's rows`);
      if (row.tier !== "on-demand") {
        throw new Error(row.tier === "off"
          ? `MCP "${args.name}" is disabled`
          : `MCP "${args.name}" is at the native tier — call its mcp__${args.name}__<tool> tools directly`);
      }
      const entry = row.entry;
      if (isToolDisabled(entry, args.tool)) throw new Error(`MCP tool "${entry.name}/${args.tool}" is disabled`);
      if (exec?.agent === undefined) throw new Error("mcp_call requires a session");
      const session = sessionOf(exec.agent);
      const connection = session.connections.get(entry.name);
      if (connection === undefined) {
        throw new Error(`MCP "${args.name}" is not loaded — call mcp_load first`);
      }
      const targetTool = Array.isArray(connection.tools)
        ? connection.tools.find((tool) => tool.name === args.tool)
        : undefined;
      const errorContext = { server: entry.name, inputSchema: targetTool?.inputSchema };
      const result = await callTool(connection.client, args.tool, args.args, toolCallTimeoutMs, exec.signal, errorContext);
      return settleMcpToolResult(
        ctx,
        exec,
        mcpCallProjections,
        result,
        args.tool,
        isErrorContextSuffix(errorContext, args.tool, args.args),
      );
    },
  };

  // ── client-UI RPC handlers (skill + mcp drawers) ──
  const BUNDLE_SKILL_RE = /(^|[\\/])SKILL\.md$/i;

  // Skills living inside the DSH install (app.asar.unpacked) or any installed
  // package's node_modules are SHIPPED/read-only: the drawer may list and open
  // them, but must never toggle or delete them — doing so would corrupt the
  // deployment or a third-party plugin. Only user-writable roots are managed.
  function isReadonlySkillPath(path) {
    return /[\\/]app\.asar|[\\/]node_modules[\\/]/.test(path);
  }

  // The built-in dsh-skill-filesystem is mounted by the agent preset, so its
  // catalog (project roots, ~/.dsh/skills, ~/.agents/skills, bundled skills) is
  // visible only when list/get carry that preset's standing scope. The Host UI
  // has no current agent, so the scope has to come from the preset registry, and
  // that API changed:
  //
  //   - 0.1.x: `agentPresets.standingKeyFor()` returns the standing key.
  //   - 0.2.0-rc.2+: that method is gone. `acquireScope(id)` returns
  //     `{ key, [Symbol.asyncDispose] }` and the key is valid only while the
  //     lease is held — so the reads must happen inside `fn` and the lease is
  //     released afterwards. A missing API (or a failed lease) degrades to the
  //     global layer, which is where this plugin's own recursive provider lives:
  //     the drawer loses the preset skills, never the page.
  async function withSkillScope(fn) {
    const presets = ctx.get("agentPresets");
    if (presets === undefined || presets === null) return fn({});
    if (typeof presets.standingKeyFor === "function") {
      try {
        return await fn({ scope: await presets.standingKeyFor() });
      } catch {
        return fn({});
      }
    }
    if (typeof presets.acquireScope === "function") {
      let lease;
      try {
        const presetId = presets.config?.selectedDefault ?? presets.config?.default;
        lease = presetId === undefined ? await presets.acquireScope() : await presets.acquireScope(presetId);
      } catch {
        return fn({});
      }
      try {
        return await fn({ scope: lease?.key });
      } finally {
        try {
          await lease?.[Symbol.asyncDispose]?.();
        } catch {
          /* a failed release must not fail the read */
        }
      }
    }
    return fn({});
  }

  async function resolveSkillPath(name, lookup) {
    const definition = await ctx.skills.get(name, lookup ?? {});
    if (definition === undefined || typeof definition.path !== "string") return undefined;
    if (!BUNDLE_SKILL_RE.test(definition.path)) return undefined;
    return definition;
  }

  // ── legacy session audit ──
  // Sessions written before 1.1.5 carry a source kind the v0 -> v3 migration
  // refuses and cannot be opened at all once DSH reaches 2.0.9. This only
  // detects them so the UI can point at the repair guide; it never writes to a
  // session log.
  //
  // Nothing is scheduled at startup. The scan is heavy enough to starve the
  // host's boot work — one frame can block the event loop for over a second, and
  // a large library takes 30-136s — while the desktop host fails `host-boot` on a
  // ~120s watchdog and drops into safe mode. Plugin load happens early in boot,
  // so neither an `await` nor a delayed timer can stay clear of that window
  // (both were tried on 2026-09-14 and both landed in it). The scan is therefore
  // started by the first UI request: if the page is asking, the app is up.
  //
  // It re-runs until its `check` flag is retired; a clean scan retires the flag
  // itself. There is no dismiss action, so an accidental click can never hide a
  // real problem.
  //
  // The `__test__` sentinel profile gets an inert runner: tests point the plugin
  // at a throwaway dataDir precisely so they never touch the real home, and
  // reading the real sessions tree would break that isolation.
  const auditRunner = bootedTarget.name === "__test__"
    ? { kick() {}, read: async () => null, running: () => false, checked: () => false }
    : createAuditRunner(dataDir, join(DSH_HOME, "sessions"), ctx.logger);

  // Live loader entries mounting the MCP bridge, bundle-provided servers
  // included. Defensive: a host without a loader service reports none.
  function loaderRecords() {
    let loader;
    try {
      loader = ctx.get("loader");
    } catch {
      loader = undefined;
    }
    return loaderMcpEntries(loader);
  }

  // The unified inventory: every MCP row the REQUESTED profile composes — its
  // user layer, its bundle layers and any row only the live loader knows about
  // — enriched with live data when (and only when) it is the profile this
  // process booted. A foreign profile is a static, read-only view: no loader
  // entries, no live tool counts.
  async function buildInventoryView(reveal, profileName) {
    const viewName = profileName !== undefined && profileName !== null && profileName !== ""
      ? assertProfileChoice(String(profileName))
      : viewProfileName();
    const booted = viewName === bootedTarget.name;
    if (!booted) {
      return await staticInventoryView(viewName, reveal);
    }

    const schemas = schemasOf(ctx);
    const { rows: bootedRows, duplicates } = await bootRowsResult();
    const records = loaderRecords();
    const view = bootedRows.map((row) => {
      const agent = agentsState.rows[row.rowId];
      const record = records.find((item) => item.serverName === row.serverName);
      const snapshot = agentsState.snapshots[row.rowId];
      let live;
      if (row.tier === "off") {
        live = { mounted: false, phase: "disabled", toolCount: 0, tools: [] };
      } else if (row.tier === "on-demand") {
        const tools = Array.isArray(snapshot?.tools) ? snapshot.tools : [];
        live = {
          mounted: true,
          phase: "proxied",
          toolCount: tools.length,
          tools: tools.map((tool) => ({ name: tool.name, description: tool.description ?? "", enabled: agent?.tools?.[tool.name] !== false })),
        };
      } else {
        const tools = toolsOfServer(schemas, row.serverName);
        live = {
          mounted: record?.entry?.fiber !== undefined,
          phase: record === undefined ? "pending" : record.phase,
          toolCount: tools.length,
          tools: tools.map((tool) => ({ name: tool.name, description: tool.description ?? "", enabled: true })),
        };
      }
      return {
        rowId: row.rowId,
        serverKey: row.serverName,
        serverName: row.serverName,
        source: row.source,
        bundle: row.bundle,
        loaderOnly: row.loaderOnly === true,
        tier: row.tier,
        enabled: row.tier !== "off",
        editable: false,
        removable: row.source === "user" && row.loaderOnly !== true,
        restartable: row.tier === "native" && record !== undefined && row.loaderOnly !== true
          ? record.entry?.fiber !== undefined
          : row.loaderOnly === true && row.tier === "native",
        unevaluated: row.unevaluated ?? "",
        snapshotAvailable: snapshot !== undefined,
        notes: agentsState.notes?.[row.rowId] ?? "",
        ...configView(row.config ?? {}, reveal),
        serverVersion: snapshot?.serverVersion ?? "",
        serverTitle: snapshot?.serverTitle ?? "",
        serverDescription: snapshot?.serverDescription ?? "",
        websiteUrl: snapshot?.websiteUrl ?? "",
        instructions: snapshot?.instructions ?? "",
        lastLoadAt: snapshot?.fetchedAt ?? null,
        live,
      };
    });

    const builtin = BUILTIN_PROVIDERS.flatMap((provider) => {
      let service;
      try {
        service = ctx.get(provider.service);
      } catch {
        service = undefined;
      }
      if (service === undefined) return [];
      const live = toolsOfBuiltin(schemas, provider.service);
      return [{
        rowId: `builtin-${provider.serverName}`,
        serverKey: provider.serverName,
        serverName: provider.serverName,
        source: "builtin",
        bundle: null,
        loaderOnly: false,
        tier: "native",
        enabled: true,
        editable: false,
        removable: false,
        restartable: false,
        unevaluated: "",
        snapshotAvailable: false,
        notes: "",
        label: provider.label,
        transport: "built-in",
        command: null,
        args: [],
        env: {},
        cwd: null,
        url: null,
        headers: {},
        live: { mounted: true, phase: "active", toolCount: live.length, tools: live.map((tool) => ({ name: tool.name, description: tool.description ?? "", enabled: true })) },
      }];
    });

    return {
      ok: true,
      profile: { name: viewName, booted: true, patchPath: bootedTarget.patchPath, writable: true },
      counts: countRows(view, builtin),
      rows: view,
      duplicates: duplicates.map((row) => ({ rowId: row.rowId, serverName: row.serverName, source: row.source, bundle: row.bundle })),
      builtin,
    };
  }

  function countRows(view, builtin) {
    const counts = { user: 0, bundle: 0, builtin: builtin.length, on: 0 };
    for (const row of view) {
      if (row.source === "user") counts.user += 1;
      else counts.bundle += 1;
      if (row.enabled) counts.on += 1;
    }
    return counts;
  }

  // A profile that is not running: rows come from its patch layers only.
  async function staticInventoryView(viewName, reveal) {
    const viewDir = join(bootedTarget.profilesRoot, viewName);
    const found = await discoverRows({ profileDir: viewDir, dshHome: DSH_HOME });
    const agents = await loadAgents(dataDir, viewName);
    const view = found.rows.map((row) => {
      const agent = agents.rows[row.rowId];
      const proxied = agent !== undefined && row.disabled;
      const tier = proxied ? "on-demand" : row.disabled ? "off" : "native";
      const snapshot = agents.snapshots[row.rowId];
      return {
        rowId: row.rowId,
        serverKey: row.serverName,
        serverName: row.serverName,
        source: row.source,
        bundle: row.bundle,
        loaderOnly: false,
        tier,
        enabled: tier !== "off",
        editable: false,
        removable: false,
        restartable: false,
        unevaluated: row.unevaluated ?? "",
        snapshotAvailable: snapshot !== undefined,
        notes: agents.notes?.[row.rowId] ?? "",
        ...configView(row.config ?? {}, reveal),
        serverVersion: snapshot?.serverVersion ?? "",
        serverTitle: snapshot?.serverTitle ?? "",
        serverDescription: snapshot?.serverDescription ?? "",
        websiteUrl: snapshot?.websiteUrl ?? "",
        instructions: snapshot?.instructions ?? "",
        lastLoadAt: snapshot?.fetchedAt ?? null,
        live: {
          mounted: null,
          phase: null,
          toolCount: Array.isArray(snapshot?.tools) ? snapshot.tools.length : null,
          tools: [],
        },
      };
    });
    return {
      ok: true,
      profile: { name: viewName, booted: false, patchPath: join(viewDir, "cordis.patch.yml"), writable: false },
      counts: countRows(view, []),
      rows: view,
      duplicates: found.duplicates.map((row) => ({ rowId: row.rowId, serverName: row.serverName, source: row.source, bundle: row.bundle })),
      builtin: [],
    };
  }

  const uiHandlers = {
    async listSkills() {
      // One scope lease covers both the list and every follow-up definition
      // read: the preset key is invalidated as soon as the lease is released.
      return await withSkillScope(async (lookup) => {
        const summaries = await ctx.skills.list(lookup);
        const views = [];
        for (const summary of summaries) {
          const definition = await resolveSkillPath(summary.name, lookup);
          if (definition === undefined) continue;
          views.push({
            name: definition.name,
            description: definition.description ?? "",
            path: definition.path,
            directory: dirname(definition.path),
            source: definition.source ?? "",
            provider: definition.provider ?? "",
            modelInvocable: definition.invocation?.modelInvocable !== false,
            userInvocable: definition.invocation?.userInvocable !== false,
            readonly: isReadonlySkillPath(definition.path),
            ...(definition.whenToUse !== undefined ? { whenToUse: definition.whenToUse } : {}),
          });
        }
        views.sort((a, b) => a.path.localeCompare(b.path));
        return views;
      });
    },
    async toggleSkill(name, enabled) {
      const definition = await withSkillScope((lookup) => resolveSkillPath(name, lookup));
      if (definition === undefined) throw new Error(`skill "${name}" not found or not a bundle skill`);
      if (isReadonlySkillPath(definition.path)) throw new Error(`skill "${name}" is shipped/read-only and cannot be toggled`);
      const result = await setDisableModelInvocation(definition.path, !enabled);
      return {
        name: definition.name,
        path: definition.path,
        directory: dirname(definition.path),
        modelInvocable: result.modelInvocable,
        changed: result.changed,
      };
    },
    async openSkill(name) {
      const definition = await withSkillScope((lookup) => resolveSkillPath(name, lookup));
      if (definition === undefined) throw new Error(`skill "${name}" not found or not a bundle skill`);
      if (!openWithSystemEditor(definition.path)) throw new Error(`no default handler available to open ${definition.path}`);
      return { ok: true, path: definition.path };
    },
    async deleteSkill(name) {
      const definition = await withSkillScope((lookup) => resolveSkillPath(name, lookup));
      if (definition === undefined) throw new Error(`skill "${name}" not found or not a bundle skill`);
      if (isReadonlySkillPath(definition.path)) throw new Error(`skill "${name}" is shipped/read-only and cannot be deleted`);
      return trashDirectory(dirname(definition.path), dataDir);
    },
    async listMcp(reveal) {
      // Rows of the booted profile in the entry-like view the legacy /mcp
      // command renders. Superseded by listInventory; kept for the command.
      const rows = await bootRows();
      return rows.map((row) => ({ ...row.entry, tier: row.tier === "native" ? "eager" : row.tier, rowId: row.rowId, source: row.source }));
    },
    async setTier(body) {
      return await setRowTier(String(body?.rowId ?? ""), String(body?.tier ?? ""));
    },
    async setToolEnabled(body) {
      return await setRowToolEnabled(String(body?.rowId ?? ""), String(body?.tool ?? ""), body?.enabled === true);
    },
    async deleteMcp(body) {
      return await deleteRow(String(body?.rowId ?? ""));
    },
    async peekMcp(body) {
      const row = await agentRowByName(String(body?.name ?? ""));
      if (row === undefined) throw new Error(`MCP "${body?.name}" is not in the booted profile's rows`);
      if (row.tier === "off") throw new Error(`MCP "${row.serverName}" is disabled`);
      return { ok: true, text: renderDefinitions(row.entry, row.entry.tools ?? []) };
    },
    async refreshSnapshot(body) {
      return await refreshRowSnapshot(String(body?.rowId ?? ""));
    },
    async listInventory(reveal, profileName) {
      return await buildInventoryView(reveal === true, profileName);
    },
    // Re-enable/disable through the patch layer is the same lever as the tier
    // select; kept as its own route for the row switch control.
    async toggleRow(body) {
      const rows = await bootRows();
      const row = rows.find((candidate) => candidate.rowId === String(body?.rowId ?? ""));
      if (row === undefined) throw new Error(`row "${body?.rowId}" is not in the booted profile`);
      return await setRowTier(row.rowId, row.tier === "off" ? "native" : "off");
    },
    async restartRow(name) {
      const serverName = typeof name === "string" ? name.trim() : "";
      if (serverName === "") throw new Error("a server name is required");
      const record = loaderRecords().find((item) => item.serverName === serverName);
      if (record === undefined) throw new Error(`MCP "${serverName}" is not mounted in this process`);
      if (record.disabled) throw new Error(`MCP "${serverName}" is disabled; enable it first`);
      const entry = record.entry;
      if (typeof entry?._dispose === "function" && typeof entry?.init === "function") {
        await entry._dispose();
        await entry.init();
        return { ok: true, serverName, message: `restarted ${serverName}` };
      }
      const fiber = entry?.fiber;
      if (fiber === undefined || fiber.state === FIBER_DISPOSED) {
        throw new Error(`MCP "${serverName}" is not mounted and cannot be restarted`);
      }
      if (typeof fiber.restart !== "function") {
        throw new Error("this loader does not support in-place restarts; restart dsh");
      }
      await fiber.restart();
      return { ok: true, serverName, message: `restarted ${serverName}` };
    },
    async getSettings() {
      return {
        toolDescriptionMaxLength,
        localCommandApproval,
        lanHostAllowlist: [...lanHostAllowlist],
        stdioMaxBufferSizeMb,
        viewProfile: viewProfileName(),
        bootedProfile: bootedTarget.name,
      };
    },
    async setSettings(body) {
      // The view profile is a display preference with its own route; a stray
      // settings POST must not move it.
      if (body.viewProfile !== undefined) {
        throw new Error("use POST /skill-mcp-manager/view-profile to change the displayed profile");
      }
      const settings = { ...settingsState };
      if (body.toolDescriptionMaxLength !== undefined) {
        const n = Number(body.toolDescriptionMaxLength);
        if (!Number.isInteger(n) || n <= 0 || n > 5000) {
          throw new Error("toolDescriptionMaxLength must be a positive integer (<= 5000)");
        }
        toolDescriptionMaxLength = n;
        settings.toolDescriptionMaxLength = n;
      }
      if (body.localCommandApproval !== undefined) {
        if (!LOCAL_COMMAND_APPROVALS.has(body.localCommandApproval)) {
          throw new Error("localCommandApproval must be follow, always-ask, or always-allow");
        }
        localCommandApproval = body.localCommandApproval;
        settings.localCommandApproval = body.localCommandApproval;
      }
      if (body.lanHostAllowlist !== undefined) {
        lanHostAllowlist = normalizeLanHostAllowlist(body.lanHostAllowlist);
        settings.lanHostAllowlist = [...lanHostAllowlist];
      }
      if (body.stdioMaxBufferSizeMb !== undefined) {
        const raw = body.stdioMaxBufferSizeMb;
        if (raw !== null && (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0)) {
          throw new Error("stdioMaxBufferSizeMb must be a positive integer (MB) or null to use the SDK default");
        }
        applyStdioMaxBufferSizeSetting(raw);
        settings.stdioMaxBufferSizeMb = stdioMaxBufferSizeMb;
      }
      await saveSettings(dataDir, settings);
      settingsState = settings;
      return {
        ok: true,
        toolDescriptionMaxLength,
        localCommandApproval,
        lanHostAllowlist: [...lanHostAllowlist],
        stdioMaxBufferSizeMb,
        viewProfile: viewProfileName(),
        bootedProfile: bootedTarget.name,
      };
    },
    async getProfileState() {
      return { ok: true, ...(await profileSnapshot()) };
    },
    async setViewProfile(body) {
      return await setViewProfile(body?.name);
    },
    // One line for the /mcp command: which profile the bridge runs on.
    profileSummary() {
      return `${bootedTarget.name} (booted, ${bootedTarget.source})`;
    },
    // The browser guard's LAN allowlist, read live by every route.
    lanHostAllowlist() {
      return [...lanHostAllowlist];
    },
    // /mcp prepare-uninstall: drop this plugin's overrides and agent state.
    async prepareUninstall() {
      return await prepareUninstall();
    },
    async getSessionAudit() {
      // This request IS the scan trigger (see `auditRunner` above), and the scan
      // itself must not be awaited: it takes tens of seconds and this response
      // sits on the client's page-load path. The client polls `scanning` instead.
      auditRunner.kick();
      // A scan actually in flight is what the client shows a wait notice for.
      // `running()` goes false the instant the answer lands, so there is no
      // window where the UI waits on a scan that has already finished.
      if (auditRunner.running()) return { scanning: true };
      const record = await auditRunner.read();
      // Settled and still nothing on disk means this check has nothing left to
      // do — a machine that never had legacy logs writes no record at all. That
      // is reported as done, not as "waiting", so the UI stays quiet instead of
      // showing a check that will never finish.
      if (record === null) return { done: true, checked: auditRunner.checked() };
      return {
        done: true,
        // Whether a scan ran in this process, as opposed to a record that was
        // already on disk. The UI announces a result only for a scan that ran,
        // so a retired check is not re-announced on every start.
        checked: auditRunner.checked(),
        // A retired check is reported as off, so the notice hides as soon as the
        // scan that found nothing has been recorded.
        check: record.check === true,
        scanned: record.scanned,
        affected: record.affected,
        checkedAt: record.checkedAt,
      };
    },
  };

  // webServer is provided lazily by the web-app bundle; acquire it by waiting
  // on it (the same ctx.inject pattern dshmarket uses). A synchronous
  // ctx.get("webServer") here would return undefined and the routes would never
  // register, so the browser would get the SPA fallback instead of JSON.
  if (typeof ctx.inject === "function") {
    ctx.inject(["webServer"], (hostCtx) => {
      mountUi(hostCtx, uiHandlers, { dataDir, webServer: hostCtx.webServer });
    });
  } else {
    mountUi(ctx, uiHandlers, { dataDir });
  }

  // ── pre-step catalog injector ──
  // Mirror dsh-tool-skill's skill-catalog: decide from the durable session
  // surface, not a process-local flag. Compaction can drop the previous
  // mcp-catalog off the surface while the registry is unchanged; in that case
  // the catalog must be re-appended.
  //
  // Identity is the model-facing text itself, compared as a whole string. A
  // stored digest would have to ride in `source`, and `source` must stay
  // minimal: the released migration edges audit message sources (v2→v3 admits
  // only its 15 built-in kinds; v0→v1 admits the `{kind:"plugin", plugin}` pair
  // plus `form`/`sections`/`summary`), and a `digest` member once made every
  // historical log unloadable on the next format generation (2026-09-11
  // incident). The text needs no carrier: it is already durable as the message
  // content.
  ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
    await ensureSessionRuntime(agent);
    signal.throwIfAborted();
    const decision = await next();
    if (decision.kind === "reject") return decision;
    signal.throwIfAborted();
    const rows = (await bootRows()).filter((row) => row.tier !== "off");
    if (rows.length === 0) return decision;
    const message = renderCatalog(catalogEntries(rows, sessionOf(agent)));
    const text = message.content[0].text;
    if (visibleCatalogText(agent) === text) return decision;
    if (pendingCatalogText(decision.messages) === text) return decision;
    return { kind: "enter", messages: [...decision.messages, message] };
  });

  // Entries are the projection the model-facing prose derives from (same-source
  // principle, like the built-in skill-catalog). Nothing else is persisted.
  function catalogEntries(rows, session) {
    return rows.map((row) => ({
      name: row.serverName,
      // The model-facing vocabulary keeps the historical words: native rows
      // are "eager" (their mcp__<server>__<tool> tools are registered by the
      // dsh-mcp-client itself), proxied rows are "on-demand".
      tier: row.tier === "native" ? "eager" : row.tier,
      description: truncate(row.entry.serverDescription ?? "", catalogDescriptionMaxLength),
      notes: agentsState.notes?.[row.rowId] ?? "",
      tools: enabledTools(row.entry, row.entry.tools).map((tool) => ({
        name: tool.name,
        description: truncate(tool.description ?? "", toolDescriptionMaxLength),
      })),
    }));
  }

  // SessionSeq guard, mirroring the built-in skill-catalog.
  function sessionSeq(value) {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
      throw new TypeError(`SessionSeq must be a non-negative safe integer, got ${String(value)}`);
    }
    return value;
  }

  // The producer-owned source kind, and no declared `form`: the host renders a
  // context without a recognized form as the model-facing text itself
  // (OpaqueBody), so what a human expands is exactly what the model read.
  //
  // Session format v4 retired the bare `kind:"plugin"` + `plugin` pair: its
  // writer refuses that source outright ("format v4 message requires a
  // producer-owned source kind"), which failed every turn while this plugin
  // injected its catalog (2026-09-28). `plugin:<name>` is the kind the kernel's
  // own v3→v4 edge derives for a plugin it does not know (`producerKind()`
  // falls back to `plugin:${plugin}`), so rows written before this change read
  // back under exactly this shape and stay recognisable below.
  const CATALOG_SOURCE = { kind: "plugin:dsh-skill-mcp-manager" };

  // The model-facing text of one of this plugin's catalog messages, or
  // undefined for anything else. Identity is `source.kind` alone: the v3→v4
  // edge rewrites legacy `{kind:"plugin", plugin}` rows to this kind, so both
  // generations answer the same way. Records whose text is unreadable (older
  // formats, hand-edited logs) count as "not this plugin's catalog" and never
  // as a visible catalog.
  function catalogMessageText(message) {
    if (message?.source?.kind !== CATALOG_SOURCE.kind) return undefined;
    const block = Array.isArray(message.content) ? message.content[0] : undefined;
    return typeof block?.text === "string" && block.text !== "" ? block.text : undefined;
  }

  // The host Session exposes no `events` array (the public API is eventAt/seq/
  // snapshotEvents) — walk the durable log backwards via eventAt and return the
  // text of the newest catalog still visible on the session surface.
  function visibleCatalogText(agent) {
    const visible = new Set(agent?.session?.surface?.nodes ?? []);
    const session = agent?.session;
    if (typeof session?.seq !== "number" || typeof session?.eventAt !== "function") return undefined;
    for (let index = session.seq - 1; index >= 0; index -= 1) {
      const event = session.eventAt(sessionSeq(index));
      if (event?.type !== "user/message") continue;
      const text = catalogMessageText(event.data);
      if (text === undefined) continue;
      if (visible.has(event.seq)) return text;
    }
    return undefined;
  }

  function pendingCatalogText(messages) {
    if (!Array.isArray(messages)) return undefined;
    for (const message of messages) {
      const text = catalogMessageText(message);
      if (text !== undefined) return text;
    }
    return undefined;
  }

  function renderCatalog(entries) {
    const lines = [];
    for (const entry of entries) {
      let line = `- \`${entry.name}\` (${entry.tier}): ${entry.description !== "" ? entry.description : "(no description)"}`;
      if (entry.tier === "on-demand" && entry.notes) line += ` (notes: ${entry.notes})`;
      lines.push(line);
      for (const tool of entry.tools) {
        lines.push(`  - ${tool.name}${tool.description ? `: ${tool.description}` : ""}`);
      }
    }
    const text = [
      "<system-reminder>",
      "The following MCP servers are available in this session:",
      "",
      "<mcp_catalog>",
      ...lines,
      "</mcp_catalog>",
      "",
      "用法：mcp_load / mcp_register / mcp_call 是能力库自带的管理工具，直接调用即可——它们不是某个 MCP 服务器的工具，切勿经 mcp_call 通道去转调它们。eager 服务器直接调 mcp__<server>__<tool>。on-demand 服务器先 mcp_load 拿工具名/参数，再 mcp_call {name, tool, args} 调用；未 mcp_load 直接 mcp_call 会报错。带 tools 的条目说明已有缓存；无 tools 的需先 mcp_load。disabled 服务器和工具均已隐藏。",
      "</system-reminder>",
    ].join("\n");
    return createUserMessage({
      content: [{ type: "text", text }],
      // The source stays minimal: SourceFields displays every source field, so
      // carrying entries there would render the same information twice, and a
      // digest member would be refused by the migration audit.
      source: { ...CATALOG_SOURCE },
    });
  }

  // ── effect-scoped registration (synchronous, before any await) ──
  const toolDisposers = [
    ctx.tools.register(mcpRegister),
    ctx.tools.register(mcpLoad),
    ctx.tools.register(mcpCall),
  ];
  // /prepare-uninstall command (optional: only when ctx.commands is composed).
  const commands = ctx.get("commands");
  const commandDisposer = commands !== undefined
    ? commands.register({
        name: "prepare-uninstall",
        description: "Hand managed MCP entries back to the native dsh-mcp-client before uninstalling this plugin",
        handler: () => prepareUninstall(),
      })
    : () => {};
  ctx.effect(() => {
    return async () => {
      commandDisposer();
      for (const dispose of toolDisposers) dispose();
      for (const session of [...liveSessions]) {
        liveSessions.delete(session);
        await disposeSession(session);
      }
    };
  });

  // ── skill provider (M1) ──
  registerRecursiveSkillProvider(ctx, dataDir);

  // ── startup ──
  // Settings first: the managed-profile choice takes part in target resolution,
  // and the target picks both the patch to reconcile and the registry file.
  try {
    settingsState = await loadSettings(dataDir);
  } catch {
    settingsState = {};
  }
  try {
    const settings = settingsState;
    if (typeof settings.toolDescriptionMaxLength === "number" && settings.toolDescriptionMaxLength > 0) {
      toolDescriptionMaxLength = settings.toolDescriptionMaxLength;
    }
    if (LOCAL_COMMAND_APPROVALS.has(settings.localCommandApproval)) {
      localCommandApproval = settings.localCommandApproval;
    }
    if (Array.isArray(settings.lanHostAllowlist)) {
      try {
        lanHostAllowlist = normalizeLanHostAllowlist(settings.lanHostAllowlist);
      } catch {
        /* a corrupt allowlist must not block startup; the default is empty */
      }
    }
    if (settings.stdioMaxBufferSizeMb !== undefined) {
      // A corrupt value falls back to the SDK default via the same normalizer
      // the settings route uses.
      applyStdioMaxBufferSizeSetting(settings.stdioMaxBufferSizeMb);
    }
  } catch {
    /* settings.json unreadable — keep the config default */
  }
  // One-time v1 → v2 migration: dismantle the legacy managed span (if any) in
  // the booted profile's patch and express the old tiers with the v2 levers.
  try {
    await migrateManagedProfile(bootedTarget);
  } catch (error) {
    ctx.logger.error(`skill-mcp-manager: v1→v2 migration failed: ${String(error?.message ?? error)}`);
  }
  agentsState = await loadAgents(dataDir, bootedTarget.name);
  invalidateBootRows();
  try {
    await sweepOrphanAgents();
  } catch (error) {
    ctx.logger.warn(`skill-mcp-manager: orphan agent-state sweep failed: ${String(error?.message ?? error)}`);
  }
  // No warm-up: an on-demand row is connected only when a session asks for it
  // (mcp_load) or the UI refreshes its snapshot. That is the point of the tier.
  ctx.logger.info(
    `skill-mcp-manager: ready (v2 row management, profile ${bootedTarget.name} via ${bootedTarget.source}, dataDir=${dataDir})`,
  );
}

export { Config, apply, inject, name, PLUGIN_VERSION };
