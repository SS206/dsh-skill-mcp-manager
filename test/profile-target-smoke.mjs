// Profile-target smoke test (unit, no DSH runtime): resolution order, patch
// path selection, choice validation, registry file naming and profile
// enumeration.
//
// The anchor case is DSH Desktop: the host process has no `--profile` on its
// command line (the profile directory is positional) and provides
// `ctx.profileContext`, which is what a bundle-installed plugin must follow.
// Falling back to argv alone reconciled the *web* profile instead.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  argvProfile,
  legacyProfileName,
  listProfiles,
  normalizeProfileChoice,
  positionalProfile,
  registryFileOf,
  resolveProfileTarget,
} from "../lib/profile-target.js";

const failed = [];
const check = (condition, message) => {
  if (!condition) failed.push(message);
};

const home = join(homedir(), ".dsh-profile-target-smoke-" + process.pid);
const profilesRoot = join(home, "profiles");
await rm(home, { recursive: true, force: true });
for (const name of ["desktop", "web", "headless"]) {
  await mkdir(join(profilesRoot, name), { recursive: true });
}
await writeFile(join(profilesRoot, "desktop", "cordis.patch.yml"), "# desktop patch\n", "utf8");
await writeFile(join(profilesRoot, "web", "cordis.patch.yml"), "# web patch\n", "utf8");
await writeFile(join(profilesRoot, "web", "cordis.yml"), "# web composition\n", "utf8");
await writeFile(join(profilesRoot, "headless", "cordis.yml"), "# headless composition\n", "utf8");
await mkdir(join(profilesRoot, "web", "node_modules", "dsh-skill-mcp-manager"), { recursive: true });
await writeFile(join(profilesRoot, "web", "node_modules", "dsh-skill-mcp-manager", "package.json"), "{}\n", "utf8");

const desktopContext = {
  name: "desktop",
  dir: join(profilesRoot, "desktop"),
  patchPath: join(profilesRoot, "desktop", "cordis.patch.yml"),
};
const desktopArgv = ["electron", "index.js", join(profilesRoot, "desktop"), "/runtime", "/pnpm.mjs"];
const base = { argv: desktopArgv, dshHome: home };

// 1) profileContext decides when nothing is configured — the Desktop case.
let target = resolveProfileTarget({ ...base, configProfile: "", managedProfile: undefined, profileContext: desktopContext });
check(target.name === "desktop", "profileContext must be the primary source, got " + target.name);
check(target.source === "context", "source should be context, got " + target.source);
check(target.patchPath === desktopContext.patchPath, "the context patchPath must be used");
check(target.isBooted === true, "the context profile is the booted one");

// 2) CLI --profile still resolves without a context.
target = resolveProfileTarget({ configProfile: "", argv: ["node", "host.js", "--profile", "headless"], dshHome: home });
check(target.name === "headless" && target.source === "argv", "--profile must resolve via argv, got " + target.name + "/" + target.source);

// 3) Desktop-shaped positional argument without a context.
target = resolveProfileTarget({ configProfile: "", argv: ["electron", join(profilesRoot, "web")], dshHome: home });
check(target.name === "web" && target.source === "positional", "positional profile dir must resolve, got " + target.name + "/" + target.source);

// 4) A settings-page pin outranks the install config and the context.
target = resolveProfileTarget({ ...base, configProfile: "web", managedProfile: "headless", profileContext: desktopContext });
check(target.name === "headless" && target.source === "settings", "settings pin must win, got " + target.name + "/" + target.source);

// 5) "auto" forces auto-detection, ignoring the install config.
target = resolveProfileTarget({ ...base, configProfile: "web", managedProfile: "auto", profileContext: desktopContext });
check(target.name === "desktop" && target.source === "context", "auto must ignore the install config, got " + target.name);

// 6) The install config is the default when settings say nothing.
target = resolveProfileTarget({ ...base, configProfile: "web", managedProfile: undefined, profileContext: desktopContext });
check(target.name === "web" && target.source === "config", "config must apply when settings are unset, got " + target.name + "/" + target.source);

// 7) Legacy fallback stays "web"; the __test__ sentinel survives.
target = resolveProfileTarget({ configProfile: "__test__", argv: [], dshHome: home });
check(target.name === "__test__" && target.source === "config", "__test__ must survive as a profile name");
target = resolveProfileTarget({ configProfile: "", argv: [], dshHome: home });
check(target.name === "web" && target.source === "default", "the legacy default is web");

// 8) Choice validation: empty/invalid collapse, "auto" is preserved.
check(normalizeProfileChoice("") === undefined, "empty choice means unset");
check(normalizeProfileChoice("auto") === "auto", "auto is preserved");
check(normalizeProfileChoice("AUTO") === "auto", "auto is case-insensitive");
check(normalizeProfileChoice("../escape") === undefined, "path-ish names are rejected");
check(normalizeProfileChoice("..") === undefined, "dot-dot is rejected");
check(normalizeProfileChoice("__test__") === "__test__", "underscore-leading names are legal");
check(normalizeProfileChoice("a".repeat(80)) === undefined, "over-long names are rejected");

// 9) argv helpers.
check(argvProfile(["node", "x.js", "--profile", "desktop"]) === "desktop", "argvProfile reads --profile");
check(argvProfile(["node", "x.js", "--profile"]) === undefined, "a trailing --profile is ignored");
check(positionalProfile(["electron", join(homedir(), "Documents", "desktop")], profilesRoot) === undefined, "unrelated dirs are not profiles");

// 10) Registry file naming + legacy owner.
check(registryFileOf("/data", "desktop") === join("/data", "registry.desktop.json"), "registry files are per profile");
check(registryFileOf("/data", "../escape") === join("/data", "registry.web.json"), "an invalid profile falls back to the default file");
check(legacyProfileName({ configProfile: "", argv: [], profilesRoot }) === "web", "the legacy owner falls back to web");
check(legacyProfileName({ configProfile: "web", argv: ["node", "--profile", "desktop"], profilesRoot }) === "web", "an explicit config owns the legacy registry");

// 11) Enumeration marks the booted profile and plugin installs.
const profiles = await listProfiles({ profilesRoot, bootedName: "desktop" });
const names = profiles.map((item) => item.name);
check(names[0] === "desktop", "the booted profile sorts first, got " + names.join(","));
check(names.includes("web") && names.includes("headless"), "patch-only and composition-only profiles are listed");
check(profiles.find((item) => item.name === "web").pluginInstalled === true, "web is marked as having the plugin");
check(profiles.find((item) => item.name === "desktop").pluginInstalled === false, "desktop is marked as missing the plugin");
check(profiles.find((item) => item.name === "headless").patchExists === false, "headless has no patch yet");
check(profiles.find((item) => item.name === "desktop").booted === true, "the booted flag is set");

await rm(home, { recursive: true, force: true });

if (failed.length > 0) {
  for (const message of failed) console.error("FAIL:", message);
  process.exit(1);
}
console.log("PROFILE TARGET SMOKE PASSED");
