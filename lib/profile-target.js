// Which profile this plugin manages, and where that profile's user patch lives.
//
// The booted profile is authoritative and the host hands it over directly: the
// profile boot layer provides `ctx.profileContext` ({ name, dir, patchPath, … }),
// and DSH Desktop never puts `--profile` on the process command line — it passes
// the profile directory as a positional argument. Detecting from argv alone
// therefore fell back to the schema default ("web") on Desktop, so the plugin
// reconciled the *web* profile, imported nothing, and never touched the profile
// it actually lived in.
//
// Resolution order (first hit wins):
//   1. settings.json `managedProfile` — the UI choice; "auto" forces auto-detect
//   2. install config `profile`        — deployment default; "" / "auto" = auto
//   3. ctx.profileContext.name        — authoritative for every profile boot
//   4. argv `--profile <name>`        — CLI-shaped launches
//   5. argv positional `<profiles root>/<name>` — DSH Desktop
//   6. "web"                          — legacy fallback
//
// Profile names are validated against the loader's own shape so a settings value
// can never escape the profiles root through path segments.

import { access, readdir } from "node:fs/promises";
import { basename, dirname, join, normalize } from "node:path";

export const AUTO_PROFILE = "auto";
export const DEFAULT_PROFILE = "web";
export const PLUGIN_PACKAGE_NAME = "dsh-skill-mcp-manager";
export const PROFILE_PATCH_FILENAME = "cordis.patch.yml";
export const PROFILE_COMPOSITION_FILENAME = "cordis.yml";

// Underscore-leading names are legal (the test sentinel "__test__", scratch
// profiles); a leading dot is not, so ".." can never be a profile segment.
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;

/** "" / "auto" / an invalid name collapse to undefined; "auto" stays "auto". */
export function normalizeProfileChoice(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (trimmed.toLowerCase() === AUTO_PROFILE) return AUTO_PROFILE;
  return PROFILE_NAME_PATTERN.test(trimmed) ? trimmed : undefined;
}

/** Route-boundary validation: an invalid choice is a caller error, not a default. */
export function assertProfileChoice(value) {
  const normalized = normalizeProfileChoice(value);
  if (normalized === undefined) {
    throw new Error(`invalid profile "${String(value)}" (expected "auto" or a profile name of [A-Za-z0-9._-])`);
  }
  return normalized;
}

export function isProfileName(value) {
  return typeof value === "string" && PROFILE_NAME_PATTERN.test(value);
}

/** `--profile <name>` on a CLI-shaped launch, if present. */
export function argvProfile(argv = process.argv) {
  const flag = argv.indexOf("--profile");
  if (flag !== -1 && flag + 1 < argv.length && !argv[flag + 1].startsWith("-")) {
    const candidate = normalizeProfileChoice(argv[flag + 1]);
    if (candidate !== undefined && candidate !== AUTO_PROFILE) return candidate;
  }
  return undefined;
}

function samePath(left, right) {
  const a = normalize(left).replace(/[\\/]+$/, "");
  const b = normalize(right).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * The profile directory DSH Desktop passes positionally. The parent must be the
 * profiles root (preferred) or at least a `profiles` directory, so an unrelated
 * path that happens to end in a profile-shaped segment is not mistaken for one.
 */
export function positionalProfile(argv = process.argv, profilesRoot) {
  for (const arg of argv) {
    if (typeof arg !== "string" || arg === "" || arg.startsWith("-")) continue;
    const name = normalizeProfileChoice(basename(arg));
    if (name === undefined || name === AUTO_PROFILE) continue;
    const parent = dirname(arg);
    if (profilesRoot !== undefined && profilesRoot !== "") {
      if (!samePath(parent, profilesRoot)) continue;
    } else if (basename(parent) !== "profiles") {
      continue;
    }
    return name;
  }
  return undefined;
}

/** The directory holding every profile: `<dshHome>/profiles` unless the booted
 *  profile says otherwise (custom home roots). */
export function profilesRootOf(profileContext, dshHome) {
  if (profileContext !== undefined && profileContext !== null && typeof profileContext.dir === "string" && profileContext.dir !== "") {
    return dirname(profileContext.dir);
  }
  return join(dshHome, "profiles");
}

export function profileDirOf(profilesRoot, name) {
  return join(profilesRoot, name);
}

export function patchPathOf(profilesRoot, name) {
  return join(profilesRoot, name, PROFILE_PATCH_FILENAME);
}

/**
 * Resolve the managed profile.
 *
 * @returns {{ name: string, source: "settings"|"config"|"context"|"argv"|"positional"|"default",
 *             patchPath: string, profilesRoot: string, bootedName: string|undefined, isBooted: boolean }}
 */
export function resolveProfileTarget({
  configProfile,
  managedProfile,
  profileContext,
  argv = process.argv,
  dshHome,
} = {}) {
  const profilesRoot = profilesRootOf(profileContext, dshHome);
  const bootedName = typeof profileContext?.name === "string" && profileContext.name !== "" ? profileContext.name : undefined;
  const chosen = normalizeProfileChoice(managedProfile);
  const configured = normalizeProfileChoice(configProfile);

  let name;
  let source;
  if (chosen !== undefined && chosen !== AUTO_PROFILE) {
    name = chosen;
    source = "settings";
  } else if (chosen === undefined && configured !== undefined && configured !== AUTO_PROFILE) {
    name = configured;
    source = "config";
  } else if (bootedName !== undefined) {
    name = bootedName;
    source = "context";
  } else {
    const flagged = argvProfile(argv);
    if (flagged !== undefined) {
      name = flagged;
      source = "argv";
    } else {
      const positional = positionalProfile(argv, profilesRoot);
      if (positional !== undefined) {
        name = positional;
        source = "positional";
      } else {
        name = DEFAULT_PROFILE;
        source = "default";
      }
    }
  }

  const contextPatch = typeof profileContext?.patchPath === "string" && profileContext.patchPath !== ""
    ? profileContext.patchPath
    : undefined;
  const patchPath = bootedName !== undefined && name === bootedName && contextPatch !== undefined
    ? contextPatch
    : patchPathOf(profilesRoot, name);

  return {
    name,
    source,
    patchPath,
    profilesRoot,
    bootedName,
    isBooted: bootedName !== undefined && bootedName === name,
  };
}

/** The profile the pre-fix versions would have managed, used once to file the
 *  legacy `registry.json` under the right per-profile name. */
export function legacyProfileName({ configProfile, argv = process.argv, profilesRoot } = {}) {
  const configured = normalizeProfileChoice(configProfile);
  if (configured !== undefined && configured !== AUTO_PROFILE) return configured;
  return argvProfile(argv) ?? positionalProfile(argv, profilesRoot) ?? DEFAULT_PROFILE;
}

/** `<dataDir>/registry.<profile>.json`; the profile is sanitized by construction. */
export function registryFileOf(dataDir, profileName) {
  const safe = isProfileName(profileName) ? profileName : DEFAULT_PROFILE;
  return join(dataDir, `registry.${safe}.json`);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every managed-candidate profile under the profiles root: a directory that
 * carries a user patch or a composed composition. `pluginInstalled` marks the
 * profiles that also have this plugin in their own node_modules — taking over a
 * profile without it leaves that profile with no MCP client at all.
 */
export async function listProfiles({ profilesRoot, bootedName, pluginPackageName = PLUGIN_PACKAGE_NAME } = {}) {
  let entries;
  try {
    entries = await readdir(profilesRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isProfileName(entry.name)) continue;
    const dir = join(profilesRoot, entry.name);
    const [patchExists, compositionExists, pluginInstalled] = await Promise.all([
      exists(join(dir, PROFILE_PATCH_FILENAME)),
      exists(join(dir, PROFILE_COMPOSITION_FILENAME)),
      exists(join(dir, "node_modules", pluginPackageName, "package.json")),
    ]);
    if (!patchExists && !compositionExists) continue;
    found.push({
      name: entry.name,
      dir,
      patchPath: join(dir, PROFILE_PATCH_FILENAME),
      patchExists,
      compositionExists,
      pluginInstalled,
      booted: bootedName !== undefined && bootedName === entry.name,
    });
  }
  return found.sort((a, b) => (a.booted === b.booted ? a.name.localeCompare(b.name) : a.booted ? -1 : 1));
}
