// dsh-skill-mcp-manager — patch-layer MCP row discovery.
//
// The v2 architecture has no registry and no managed span: the profile's
// patch layers ARE the configuration. A row is a `@deepseek-ai/dsh-mcp-client`
// insert row in some layer — the user layer (`<profile>/cordis.patch.yml`) or
// a bundle layer (`package.json` `dsh.profile.bundles` → each bundle's own
// patch file). This module discovers them statically for ANY profile (not
// just the booted one), which is what the cross-profile inventory view needs.
//
// Loader semantics this module mirrors:
//   - layers compose in order: bundles first, then the user layer, so a user
//     insert row with the same row id REPLACES a bundle row's config, and a
//     pure user override (`- id: X` + `disabled: true|false`) flips any row;
//   - `!!js …` expressions are kept as text for the patch (never written back
//     evaluated) and evaluated separately for the value a launcher needs.
// An expression that cannot be evaluated keeps the row listed (config marked
// `unevaluated`); the plugin simply cannot proxy-launch it.

import { readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { createContext, runInContext } from "node:vm";
import { parse, stringify } from "yaml";

/** The MCP bridge package every managed row mounts. */
export const MCP_CLIENT_PACKAGE = "@deepseek-ai/dsh-mcp-client";

const LOADER_JS_TAG = {
  tag: "tag:yaml.org,2002:js",
  resolve: (value) => ({ __jsExpr: typeof value === "string" ? value : String(value) }),
};
const EXPRESSION_TIMEOUT_MS = 1000;

/**
 * Parse one top-level patch item with the `!!js` tag registered, so foreign
 * rows sharing a bundle patch file parse without warnings. Returns undefined
 * when the text does not parse.
 */
export function parsePatchItem(text) {
  try {
    return parse(text, { customTags: [LOADER_JS_TAG] });
  } catch {
    return undefined;
  }
}

// ── loader expressions (`!!js …`) ─────────────────────────────────────────

export function loaderExpressionGlobals(dshHome) {
  return {
    process: {
      execPath: process.execPath,
      platform: process.platform,
      arch: process.arch,
      argv: [...process.argv],
      env: { ...process.env },
      cwd: () => process.cwd(),
    },
    dshHomePath: (relative) => join(dshHome, String(relative)),
    path: { join, dirname, basename },
  };
}

export function evaluateLoaderExpression(expression, dshHome) {
  const context = createContext(loaderExpressionGlobals(dshHome), {
    codeGeneration: { strings: false, wasm: false },
  });
  return runInContext(`(${expression})`, context, { timeout: EXPRESSION_TIMEOUT_MS });
}

// Replace every expression marker with its value. Returns { ok, value, error }.
export function materializeLoaderExpressions(value, dshHome) {
  try {
    const walk = (node) => {
      if (Array.isArray(node)) return node.map(walk);
      if (node !== null && typeof node === "object") {
        if (typeof node.__jsExpr === "string") return evaluateLoaderExpression(node.__jsExpr, dshHome);
        const out = {};
        for (const [key, item] of Object.entries(node)) out[key] = walk(item);
        return out;
      }
      return node;
    };
    return { ok: true, value: walk(value) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function containsLoaderExpression(value) {
  if (Array.isArray(value)) return value.some(containsLoaderExpression);
  if (value !== null && typeof value === "object") {
    if (typeof value.__jsExpr === "string") return true;
    return Object.values(value).some(containsLoaderExpression);
  }
  return false;
}

// ── patch text plumbing ────────────────────────────────────────────────────
// All of these operate on the raw text so a rewrite never touches bytes it
// does not own (comments, unrelated rows, unknown keys survive verbatim).

// Top-level `- …` blocks in a patch-array slice, with line spans so a caller
// can excise whole blocks.
export function splitTopLevelPatchEntriesWithRanges(text) {
  const lines = text.split(/\r?\n/);
  const lineOffsets = [];
  let acc = 0;
  for (const line of lines) {
    lineOffsets.push(acc);
    acc += line.length + 1;
  }
  const entries = [];
  let buf = [];
  let startLine = -1;
  const flush = () => {
    while (buf.length > 0 && buf[buf.length - 1] === "") buf.pop();
    if (buf.length === 0) return;
    const startOffset = lineOffsets[startLine];
    const endLine = startLine + buf.length;
    entries.push({
      text: buf.join("\n"),
      startLine,
      lineCount: buf.length,
      startOffset,
      endOffset: lineOffsets[Math.min(endLine, lineOffsets.length - 1)] + (endLine >= lineOffsets.length ? lines[lines.length - 1].length : 0),
    });
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("- ")) {
      flush();
      startLine = i;
      buf.push(lines[i]);
    } else if (buf.length > 0) {
      buf.push(lines[i]);
    }
  }
  flush();
  return { entries, lineOffsets, lineCount: lines.length };
}

// Segment the rows of one `- insert:` entry into line spans. Row starts are
// `- ` lines at the sequence's own indent; deeper-indented lines belong to the
// current row. Returns null when the structure is not recognizable.
export function segmentInsertRows(entryText) {
  const lines = entryText.split("\n");
  let seqIndent = null;
  const rows = [];
  let current = null;
  for (let i = 1; i < lines.length; i++) {
    const match = lines[i].match(/^(\s*)- /);
    if (match !== null) {
      const indent = match[1].length;
      if (seqIndent === null) seqIndent = indent;
      if (indent === seqIndent) {
        if (current !== null) rows.push(current);
        current = { relStart: i, relEnd: lines.length };
        continue;
      }
    }
  }
  if (current !== null) rows.push(current);
  if (seqIndent === null) return null;
  for (let i = 0; i < rows.length; i++) {
    rows[i].relEnd = i + 1 < rows.length ? rows[i + 1].relStart : lines.length;
  }
  return rows;
}

// The text of one row inside a patch entry, without the blank/comment lines
// that trail it (those sit BETWEEN rows and stay in place on removal).
export function rowTextAt(lines, span) {
  if (span === undefined) return undefined;
  const rowLines = lines.slice(span.relStart, span.relEnd);
  let end = rowLines.length;
  while (end > 0) {
    const trimmed = rowLines[end - 1].trim();
    if (trimmed === "" || trimmed.startsWith("#")) end -= 1;
    else break;
  }
  const text = rowLines.slice(0, end).join("\n").replace(/\s+$/, "");
  return text === "" ? undefined : text;
}

// Row-level `disabled: true` applied to a row's own text, leaving every other
// byte alone. The flag indents like the row's `- ` marker.
export function withDisabledFlag(text, disabled) {
  if (typeof text !== "string" || text === "") return text;
  const hasFlag = /^\s*disabled\s*:/m.test(text);
  if (disabled && !hasFlag) {
    const match = /^(\s*)- /.exec(text);
    const indent = match === null ? "    " : match[1];
    return `${text.replace(/\s+$/, "")}\n${indent}  disabled: true`;
  }
  if (!disabled && hasFlag) {
    return text
      .split("\n")
      .filter((line) => !/^\s*disabled\s*:/.test(line))
      .join("\n")
      .replace(/\s+$/, "");
  }
  return text;
}

// Parse a patch section for @deepseek-ai/dsh-mcp-client insert rows, keeping
// each row's VERBATIM source text (expressions intact).
export function parseNativeMcpEntries(nativeText) {
  const found = [];
  for (const entry of splitTopLevelPatchEntriesWithRanges(nativeText).entries) {
    let parsed;
    try {
      parsed = parse(entry.text, { customTags: [LOADER_JS_TAG] });
    } catch {
      continue;
    }
    const blocks = Array.isArray(parsed) ? parsed : [parsed];
    if (blocks.length !== 1 || blocks[0] === null || typeof blocks[0] !== "object") continue;
    const insert = blocks[0].insert;
    if (!Array.isArray(insert)) continue;
    const spans = segmentInsertRows(entry.text);
    const lines = entry.text.split("\n");
    for (let index = 0; index < insert.length; index += 1) {
      const row = insert[index];
      if (row === null || typeof row !== "object" || row.name !== MCP_CLIENT_PACKAGE) continue;
      found.push({ row, text: rowTextAt(lines, spans === null ? undefined : spans[index]) });
    }
  }
  return found;
}

// ── patch-layer `disabled` overrides ──────────────────────────────────────
// The user layer can always override a row by id (`- id: mcp-exa` +
// `disabled: true|false`) — the same lever for bundle rows and user rows
// alike. With `patchReload: live` the tree re-composes about a second later.

export const OVERRIDE_ID_PATTERN = /^[A-Za-z0-9._:@/-]{1,200}$/;

// The id of one parsed top-level item when that item is a pure override.
// The tag list keeps foreign `!!js` fields (other plugins' rows share the
// same bundle patch files) parseable instead of warning.
function overrideIdOf(text) {
  let parsed;
  try {
    parsed = parse(text, { customTags: [LOADER_JS_TAG] });
  } catch {
    return undefined;
  }
  const blocks = Array.isArray(parsed) ? parsed : [parsed];
  if (blocks.length !== 1) return undefined;
  const item = blocks[0];
  if (item === null || typeof item !== "object" || Array.isArray(item)) return undefined;
  if (typeof item.id !== "string" || item.id === "") return undefined;
  if ("insert" in item) return undefined;
  for (const key of Object.keys(item)) {
    if (key !== "id" && key !== "disabled" && key !== "config" && key !== "name") return undefined;
  }
  return item.id;
}

// Map id → the `disabled` flag of every pure override item in the document.
export function listDisabledOverrides(text) {
  const overrides = new Map();
  for (const entry of splitTopLevelPatchEntriesWithRanges(text).entries) {
    const id = overrideIdOf(entry.text);
    if (id === undefined) continue;
    let parsed;
    try {
      parsed = parse(entry.text, { customTags: [LOADER_JS_TAG] });
    } catch {
      continue;
    }
    const item = Array.isArray(parsed) ? parsed[0] : parsed;
    if (item.disabled !== undefined) overrides.set(id, item.disabled === true);
  }
  return overrides;
}

// Drop every pure override for `id` and, unless `disabled` is null, append one
// fresh item. Dropping first keeps repeated toggles idempotent.
export function setDisabledOverride(text, id, disabled) {
  const { entries, lineOffsets } = splitTopLevelPatchEntriesWithRanges(text);
  const cuts = [];
  for (const entry of entries) {
    if (overrideIdOf(entry.text) !== id) continue;
    let endOffset = entry.endOffset;
    const lines = entry.text.split(/\r?\n/);
    let kept = lines.length;
    while (kept > 1) {
      const last = lines[kept - 1].trim();
      if (last !== "" && !last.startsWith("#")) break;
      kept -= 1;
      const offset = lineOffsets[entry.startLine + kept];
      if (offset !== undefined) endOffset = offset;
    }
    cuts.push([entry.startOffset, endOffset]);
  }
  let next = text;
  for (const [start, end] of cuts.sort((a, b) => b[0] - a[0])) {
    next = next.slice(0, start) + next.slice(Math.min(end, next.length));
  }
  if (disabled === null || disabled === undefined) return next;
  let base = next.replace(/\s+$/, "");
  if (base === "[]") base = "";
  const item = `- id: ${JSON.stringify(id)}\n  disabled: ${disabled === true ? "true" : "false"}`;
  return base === "" ? `${item}\n` : `${base}\n\n${item}\n`;
}

// ── row discovery ──────────────────────────────────────────────────────────

/** Read a patch file's text; "" when missing or unreadable. */
export async function readPatchText(patchPath) {
  try {
    return await readFile(patchPath, "utf8");
  } catch {
    return "";
  }
}

/**
 * One patch document → its dsh-mcp-client rows (config evaluated when
 * possible) plus the document's pure `disabled` overrides.
 *
 * @param {string} text - raw patch document text.
 * @param {string} dshHome - the DSH home loader expressions resolve against.
 * @returns {{ rows: object[], overrides: Map<string, boolean> }}
 *   Each row: { rowId, serverName, config, unevaluated, rawText, filePath,
 *               rowDisabled }.
 */
export function parseMcpRows(text, dshHome, filePath = "") {
  const overrides = listDisabledOverrides(text);
  const rows = [];
  for (const { row, text: rowText } of parseNativeMcpEntries(text)) {
    const rowId = typeof row.id === "string" && row.id !== "" ? row.id : "";
    const rawConfig = row.config ?? {};
    const serverName = typeof rawConfig.serverName === "string" ? rawConfig.serverName : "";
    const materialized = materializeLoaderExpressions(rawConfig, dshHome);
    rows.push({
      rowId,
      serverName,
      config: materialized.ok ? materialized.value : rawConfig,
      unevaluated: !materialized.ok
        ? (containsLoaderExpression(rawConfig) ? `loader expression failed: ${materialized.error}` : `config could not be materialized: ${materialized.error}`)
        : "",
      rawText: rowText ?? "",
      filePath,
      rowDisabled: row.disabled === true,
    });
  }
  return { rows, overrides };
}

/**
 * Bundle layers a profile composes: `package.json` `dsh.profile.bundles` in
 * order, each resolved through the profile's node_modules (symlinks/junctions
 * followed) to the bundle's own patch file (`dsh.bundle.patch`, default
 * `cordis.patch.yml`). Bundles that are not resolvable from the profile —
 * the host-owned official ones — are skipped: their rows live in the host
 * install, not on this disk layout, and never carry user MCP servers.
 *
 * @param {string} profileDir
 * @returns {{ pkg: string, dir: string, patchPath: string }[]}
 */
export function bundleLayers(profileDir) {
  const out = [];
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8"));
  } catch {
    return out;
  }
  const bundles = pkg?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) return out;
  for (const name of bundles) {
    if (typeof name !== "string" || name === "") continue;
    const dir = join(profileDir, "node_modules", name);
    let real;
    try {
      real = realpathSync(dir);
    } catch {
      continue;
    }
    let meta;
    try {
      meta = JSON.parse(readFileSync(join(real, "package.json"), "utf8"));
    } catch {
      continue;
    }
    const rel = meta?.dsh?.bundle?.patch;
    const patchPath = typeof rel === "string" && rel !== "" && !rel.includes("..")
      ? join(real, rel)
      : join(real, "cordis.patch.yml");
    out.push({ pkg: name, dir: real, patchPath });
  }
  return out;
}

/**
 * Discover every MCP row a profile WOULD compose, statically — works for the
 * booted profile and for any other profile alike (no live loader needed).
 *
 * Layer semantics: bundles compose in `dsh.profile.bundles` order, the user
 * layer last; a user insert row with the same row id replaces a bundle row's
 * config entirely; a pure user override flips any row (`true` off, `false`
 * forced on). Rows with an empty serverName are dropped (the bridge requires
 * one); later rows with a duplicate serverName are flagged `duplicate` and
 * kept out of the primary list (the loader would collide on tool names).
 *
 * @param {{ profileDir: string, dshHome: string }} opts
 * @returns {Promise<{ rows: object[], duplicates: object[] }>}
 *   Each row: { rowId, serverName, config, unevaluated, rawText, filePath,
 *               source: "user"|"bundle", bundle: string|null,
 *               override: true|false|null, disabled }.
 */
export async function discoverRows({ profileDir, dshHome }) {
  const layers = [];
  for (const layer of bundleLayers(profileDir)) {
    layers.push({ kind: "bundle", pkg: layer.pkg, text: await readPatchText(layer.patchPath), filePath: layer.patchPath });
  }
  const userPatchPath = join(profileDir, "cordis.patch.yml");
  layers.push({ kind: "user", pkg: null, text: await readPatchText(userPatchPath), filePath: userPatchPath });

  const byRowId = new Map();
  const order = [];
  const userOverrides = new Map();
  for (const layer of layers) {
    const { rows, overrides } = parseMcpRows(layer.text, dshHome, layer.filePath);
    if (layer.kind === "user") {
      for (const [id, flag] of overrides) userOverrides.set(id, flag);
    }
    for (const row of rows) {
      if (row.serverName === "") continue;
      const existing = row.rowId !== "" ? byRowId.get(row.rowId) : undefined;
      if (existing !== undefined) {
        // A later layer (the user layer last) replaces an earlier row with the
        // same id, exactly like the loader composes config overrides.
        Object.assign(existing, {
          serverName: row.serverName,
          config: row.config,
          unevaluated: row.unevaluated,
          rawText: row.rawText,
          filePath: row.filePath,
          source: layer.kind,
          bundle: layer.pkg,
          rowDisabled: row.rowDisabled,
        });
        continue;
      }
      const record = {
        ...row,
        source: layer.kind,
        bundle: layer.pkg,
      };
      if (row.rowId !== "") byRowId.set(row.rowId, record);
      order.push(record);
    }
  }

  const rows = [];
  const duplicates = [];
  const seenNames = new Set();
  for (const record of order) {
    const override = userOverrides.has(record.rowId) ? userOverrides.get(record.rowId) : null;
    const disabled = override === true ? true : override === false ? false : record.rowDisabled;
    const view = {
      rowId: record.rowId,
      serverName: record.serverName,
      config: record.config,
      unevaluated: record.unevaluated,
      rawText: record.rawText,
      filePath: record.filePath,
      source: record.source,
      bundle: record.bundle,
      override,
      disabled: disabled === true,
    };
    if (seenNames.has(record.serverName)) duplicates.push(view);
    else {
      seenNames.add(record.serverName);
      rows.push(view);
    }
  }
  rows.sort((a, b) => a.serverName.localeCompare(b.serverName));
  duplicates.sort((a, b) => a.serverName.localeCompare(b.serverName));
  return { rows, duplicates };
}

/**
 * Convert a discovered row (+ the plugin's agent state for it) into the entry
 * shape the bridge launches (`connectEntry`, `enabledTools`,
 * `renderDefinitions`): plain evaluated fields only.
 *
 * @param {object} row - a discoverRows row.
 * @param {object} [agent] - `{ tools: { <name>: false } }` per-tool switches.
 * @param {object} [snapshot] - cached `{ tools, serverName, … }` metadata.
 */
export function rowToEntry(row, agent = undefined, snapshot = undefined) {
  const cfg = row.config ?? {};
  return {
    id: row.rowId,
    name: row.serverName,
    tier: "on-demand",
    transport: cfg.transport,
    command: cfg.command ?? null,
    args: Array.isArray(cfg.args) ? cfg.args : [],
    env: cfg.env ?? {},
    cwd: cfg.cwd ?? null,
    url: cfg.url ?? null,
    headers: cfg.headers ?? {},
    notes: "",
    systemEntryId: row.rowId !== "" ? row.rowId : `mcp-${row.serverName}`,
    managed: false,
    registeredAt: null,
    lastLoadAt: snapshot?.fetchedAt ?? null,
    lastSyncAt: snapshot?.fetchedAt ?? null,
    tools: Array.isArray(snapshot?.tools) ? snapshot.tools : [],
    disabledTools: Object.entries(agent?.tools ?? {})
      .filter(([, enabled]) => enabled !== true)
      .map(([name]) => name),
    serverName: snapshot?.serverName ?? "",
    serverVersion: snapshot?.serverVersion ?? "",
    serverTitle: snapshot?.serverTitle ?? "",
    serverDescription: snapshot?.serverDescription ?? "",
    websiteUrl: snapshot?.websiteUrl ?? "",
    instructions: snapshot?.instructions ?? "",
    capabilities: snapshot?.capabilities ?? null,
    metaFetchedAt: snapshot?.fetchedAt ?? null,
  };
}

/**
 * Remove one row's definition from a user-layer patch document. The row is
 * located by its `id` inside `- insert:` blocks; trailing blank/comment lines
 * attached after it stay in place, and an insert block that becomes empty is
 * removed whole. Bytes that are not the row are untouched.
 *
 * @param {string} text - the user-layer patch document.
 * @param {string} rowId - the row id to remove.
 * @returns {string} the rewritten document.
 */
export function removeUserRow(text, rowId) {
  const { entries, lineOffsets } = splitTopLevelPatchEntriesWithRanges(text);
  const cuts = [];
  for (const entry of entries) {
    const parsed = parsePatchItem(entry.text);
    if (parsed === undefined) continue;
    const blocks = Array.isArray(parsed) ? parsed : [parsed];
    if (blocks.length !== 1 || blocks[0] === null || typeof blocks[0] !== "object") continue;
    const insert = blocks[0].insert;
    if (!Array.isArray(insert) || insert.length === 0) continue;
    const dshIndexes = [];
    const targetIndexes = [];
    insert.forEach((row, index) => {
      if (row === null || typeof row !== "object" || row.name !== MCP_CLIENT_PACKAGE) return;
      dshIndexes.push(index);
      if (row.id === rowId) targetIndexes.push(index);
    });
    if (targetIndexes.length === 0) continue;
    if (insert.length === dshIndexes.length && dshIndexes.length === targetIndexes.length) {
      // Whole entry goes; keep trailing comment lines attached after it.
      let endOffset = entry.endOffset;
      const entryLines = entry.text.split(/\r?\n/);
      while (entryLines.length > 0) {
        const last = entryLines[entryLines.length - 1].trim();
        if (last === "" || last.startsWith("#")) {
          entryLines.pop();
          endOffset = lineOffsets[entry.startLine + entryLines.length] ?? endOffset;
        } else break;
      }
      cuts.push([entry.startOffset, endOffset]);
      continue;
    }
    const spans = segmentInsertRows(entry.text);
    if (spans === null || spans.length !== insert.length) continue;
    const entryLines = entry.text.split("\n");
    const relOffsets = [];
    let relAcc = 0;
    for (const line of entryLines) {
      relOffsets.push(relAcc);
      relAcc += line.length + 1;
    }
    for (const index of targetIndexes) {
      const span = spans[index];
      const start = entry.startOffset + relOffsets[span.relStart];
      const lastLine = Math.min(span.relEnd, entryLines.length - 1);
      const end = entry.startOffset + relOffsets[lastLine] + (entryLines[lastLine]?.length ?? 0) + 1;
      cuts.push([start, Math.min(end, text.length)]);
    }
  }
  let next = text;
  for (const [start, end] of cuts.sort((a, b) => b[0] - a[0])) {
    next = next.slice(0, start) + next.slice(Math.min(end, next.length));
  }
  return next;
}

/**
 * Emit a fresh user-layer insert block for a new row (mcp_register). Plain
 * values only — expressions are never minted here, so a plain YAML dump is
 * exactly the hand-written shape.
 */
export function emitInsertBlock(rowId, config) {
  return stringify([{ insert: [{ id: rowId, name: MCP_CLIENT_PACKAGE, config }] }]) + "\n";
}