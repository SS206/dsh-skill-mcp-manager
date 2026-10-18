# Capability (能力库) — dsh-skill-mcp-manager

[English](README.md) | [简体中文](README.zh.md)

One-stop SKILL & MCP manager — a **host-level plugin** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) with MCP **on-demand loading**: no more worrying about too many MCP tools burning your tokens.

## Screenshots

MCP management
![MCP 管理](docs/screenshot-mcp.png)

SKILL management
![SKILL 管理](docs/screenshot-skills.png)

## Core features

### 1. One-stop visual management

Which Skills **and** MCPs are installed? Are they enabled? What does each one do? All visible directly in the settings page — **no digging through layers**. Enable/disable and delete MCPs and Skills from the UI, and click a SKILL to view its source (opens with your local default markdown reader). Each MCP tool can also be enabled or disabled independently; a disabled tool cannot be called by the AI and does not affect other tools on the same server.

### 2. MCP on-demand loading (the core feature, carefully polished)

At session start, an on-demand server exposes only its **name + short tool descriptions**. The AI knows each tool exists and what it does, without the full schemas. That means:

- **A balance between token bill and full context** — exposing only the manager means everything else requires a tool call to inspect, which risks the AI never realizing something exists and never going to check what's available; but sending the full schemas bloats the context. This plugin treats MCP and SKILL the same way: it provides the basic **name + description** and lets the AI decide what to load.
- **No startup latency** — the server connects only when the AI actually needs it.
- **No failed-load dead end** — loading is on demand, and a failure is non-fatal (retry / reload later).

### 3. Per-session MCP instances

Every DSH session (including subagents) creates, holds, and disposes its **own instance** of each MCP config: stdio servers get one subprocess per session, HTTP servers one connection per session. When multiple sessions drive stateful tools like Playwright concurrently, each operates its own browser pages — **no clobbering across sessions** — and instances are automatically disposed when their session ends. Eager tools are registered by each session in its own context; MCP configuration (registry, tiers, per-tool disables, secrets, notes) remains globally shared.

### 4. In-session MCP hot reload

Updated your own local MCP server? Just `mcp_load` it in the session — reconnect, re-list tools, fresh snapshot. **No new session, no DSH restart — extremely friendly to MCP development.** The reconnect only affects the current session's instance; other sessions are untouched.

### 5. SKILL deep scan, external libraries, temporary hide

- Recursively discovers `<dir>/SKILL.md` at **any depth** — connect any number of external skill-library directories, at any depth, so you can group SKILLs flexibly. The plugin only scans `<dir>/SKILL.md`, so other files in a folder (e.g. `readme.md`, `reference.md`, backup files) are never picked up as skills.
- Hiding a skill = invisible to the model (writes `disable-model-invocation`), while your `/name` slash command **still works**.
- Delete moves the whole `<dir>/` folder to the recycle bin — recoverable when needed.

## Other helpful features

To make the plugin easy and reassuring to use, it also includes:

### 6. Management, not ownership

The plugin neither stores nor rewrites an MCP definition. Every `@deepseek-ai/dsh-mcp-client` row belongs to the layer that declares it — the profile's `cordis.patch.yml`, or a bundle's own patch file — and the native DSH client loads it as usual. What the plugin does is **discover, display and retier per row**:

- **常驻 / eager** (default): writes nothing; the native `dsh-mcp-client` loads it;
- **按需 / on-demand**: writes a `disabled` override that holds the native client off and lets this plugin's bridge start the server per session (less context, a controlled tool face);
- **关闭 / disabled**: writes the override only; nobody loads it.

All three are reversible patch-layer facts — delete the override by hand and the row is back to eager. Removing or disabling the plugin never affects a single MCP definition. The old takeover (and the "managed span" it wrote) is gone in 2.0; on first start the plugin dismantles any v1 span, writes those rows back verbatim, and archives the old registry.

### 7. Your note on every MCP

Attach a user note to any MCP; it is shown to the AI in the session catalog and is **never overwritten** by server/developer updates. For example: *"If server A goes down, use server B as a backup."*

### 8. Auto warm-up

After install the plugin connects once to fetch real tool names and descriptions, so the catalog is immediately useful. The cache is refreshed automatically every time an MCP is loaded. Warm-up and snapshot refresh are one-shot trial connections — they close when done and never leave a live instance.

### 9. Validated registration

`mcp_register` **trial-connects + lists tools before persisting** — only correctly configured servers are admitted.

### 10. Profile-scoped by default, switchable on demand

The **running** profile is the one this host booted (read from the host's `profileContext`, never guessed from the command line) — no overreach, no misplacement; it is the only profile whose rows are writable. The settings page's "查看 profile" picker only chooses which profile's inventory is DISPLAYED: switching it takes nothing over and hands nothing back. A profile that is not running is a read-only static view (rows read from its patch and bundle layers).

### 11. Every MCP source in one list, and settings where they belong

**Settings → Capability** is one page with an animated **Skills / MCP** tab strip. The MCP tab holds exactly two things: the **view-profile** picker (which profile's inventory is DISPLAYED — a display preference, nothing to confirm) and one list of every row the profile composes — **patch layer** (rows in `<profile>/cordis.patch.yml`: tier, restart, delete) and **bundle** (rows another bundle contributes statically, e.g. exa and calagopus: tier, restart; their config belongs to the bundle), plus the harness's **built-in** tool providers (computer-use / browser-use, read-only). Rows that only the live loader knows about (a `--patch` overlay, a host-owned bundle) are listed as bundle rows too. Live tool lists come from the model-facing schemas, so what the page shows is what the model can actually call. A foreign profile is read-only and static. Skill descriptions collapse by default, which keeps the list readable.

Plugin-wide settings (tool description truncation, stdio buffer, local-command approval, LAN allowlist) moved to the plugin's own page in the DSH plugin manager — **Plugins → dsh-skill-mcp-manager** — through the official keyed seat `plugins.bundle.config`, with a settings-row fallback for a shell that never declares that seat.

Because the browser half ships separately from the host process, a client newer than the running host degrades to the managed list with a "restart DSH" notice instead of failing.
## Install

```bash
dsh plugin --profile <profile> add dsh-skill-mcp-manager
```

Then add one row to that profile's `cordis.patch.yml` (see [`cordis.patch.example.yml`](cordis.patch.example.yml)):

```yaml
- insert:
    - id: skill-mcp-manager
      name: 'dsh-skill-mcp-manager'
      config:
        dataDir: ''            # empty = ~/.dsh/skill-mcp-manager
        # '' / auto = follow the booted profile (recommended: the plugin manages
        # the profile it is installed into; DSH Desktop passes the profile as a
        # positional argument and never sets --profile).
        # A name is the install-time default; the settings page can switch it.
        profile: ''
        trialTimeoutMs: 30000
        toolCallTimeoutMs: 60000
        catalogDescriptionMaxLength: 500
        toolDescriptionMaxLength: 150   # per-tool description truncation in the catalog (adjustable)
        importNativeMcp: true           # take over native dsh-mcp-client rows on boot
```

Restart the profile. The plugin lives in the Host composition, so the `mcp_register` / `mcp_load` / `mcp_call` trio is visible to every session in that profile; eager tools are registered by each session in its own context, and MCP runtime instances are per-session.

> **Loader expressions:** a native row's `!!js …` expression is **evaluated** for this plugin to launch the server, while the patch keeps the **expression text** (handed back verbatim on switch/uninstall). A row whose expression cannot be evaluated is **not adopted** — it stays native, with a warning in the log.

> **Takeover note:** with `importNativeMcp: true` (default), native `dsh-mcp-client` rows are imported into the capability library and disabled at the native layer — the capability library becomes the single entry point (three tiers, `mcp-catalog`, the UI). Run `/mcp prepare-uninstall` before uninstalling to hand the entries back.

## Usage

### In the UI

Open **Settings → Capability**:

- **SKILL tab** — every managed skill (bundle `SKILL.md`), sorted by path: model-visibility switch, open in system editor, cross-platform delete. Skills shipped with the deployment (under `node_modules` / `app.asar`) are read-only: view + open only.
- **MCP tab → 查看 profile row** — which profile's inventory is displayed (booted by default), with the booted profile's patch path and a read-only notice when the view is not the running profile. Choosing a view writes a display preference only.
- **MCP tab** — every row with tier badges and tool counts: switch tier (常驻 / 按需 / 关闭), restart a loader-mounted row in place, inspect details (command / env / headers / server-declared metadata / tools), enable or disable individual tools **on an on-demand row** (a native row's tool face belongs to the dsh-mcp-client), mask or reveal secrets, peek the description, refresh the cached snapshot. Snapshot refresh trial-connects, caches the metadata + tool list, then closes; it does not leave a live instance and never happens at startup. A setting row adjusts the catalog's **tool-description truncation** (default 150 chars).

### Model-facing tools

The plugin provides three small, fixed tools to manage all on-demand MCPs.

- **`mcp_register`** — add or modify an MCP entry. Trial-connects (30s) + lists tools, then persists; the server's own description / version / title / website / instructions are captured automatically. Reuse it to change tier / parameters / notes; only connection-contract changes re-connect.

  ```text
  mcp_register { name, tier?, transport, command?, args?, env?, cwd?, url?, headers?, notes? }
  ```

  `tier` ∈ `eager` | `on-demand` | `disabled` (default `on-demand`). Note that `eager` now means "written into the patch layer and loaded by the native `dsh-mcp-client`" — this plugin no longer registers native tools itself. A call that only names `notes`/`tier` is a partial update: no reconnect, no program restart. `notes` is user-maintained and is not overwritten by developer MCP updates.
- **`mcp_load { name, peek? }`** — load / hot-reload a server instance **for the current session**, returning full tool definitions + server-declared metadata; other sessions are unaffected. `peek: true` only reads the snapshot — no connect, no disconnect — handy when the AI forgot a tool's parameters and wants a quick peek without interrupting the MCP's live process. Especially friendly for stateful MCPs like browser automation.
- **`mcp_call { name, tool, args? }`** — invoke an on-demand tool (must `mcp_load` first) through **the current session's** loaded instance. Structured `args` only — never shell text, never a temp file. Malformed shapes (missing/non-string `tool`, non-object `args`) are rejected with the correct shape spelled out, never auto-unwrapped; failed calls (protocol errors and server `isError` results) echo back `called MCP tool: <server>/<tool>` plus the exact `arguments` sent so the model can self-correct.

## Config

| Field                           | Default                      | Meaning                                                                                                        |
| ------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `dataDir`                     | `~/.dsh/skill-mcp-manager` | Registry/settings directory (`~/` is expanded).                                                              |
| `profile`                     | `''` (auto)               | Profile whose `cordis.patch.yml` is reconciled. `''` / `auto` follows the booted profile — DSH Desktop never sets `--profile`, so a bundle install must not guess. A name pins the install-time default; the settings page can switch the target at runtime (stored in `settings.json`). |
| `trialTimeoutMs`              | `30000`                    | Trial-connection timeout used by `mcp_register` / `mcp_load`.                                              |
| `toolCallTimeoutMs`           | `60000`                    | Per `tools/call` timeout.                                                                                    |
| `catalogDescriptionMaxLength` | `500`                      | Truncation for the server description in the catalog.                                                          |
| `toolDescriptionMaxLength`    | `150`                      | Truncation for each tool's description in the catalog (tool names always shown in full). Adjustable in the UI. |
| `importNativeMcp`             | `true`                     | On boot, import native `dsh-mcp-client` rows into the capability library and take them over.                 |

## Data

- **MCP definitions are not in the plugin's data dir** — they are your profile's patch files (`<profile>/cordis.patch.yml` plus each bundle's patch).
- `~/.dsh/skill-mcp-manager/agents.<profile>.json` — plugin-private state: the rows this plugin proxies (on-demand), their per-tool switches, the cached server snapshots and notes. Absent when no row is proxied.
- `~/.dsh/skill-mcp-manager/settings.json` — plugin settings (`customRecursiveDirs`, `toolDescriptionMaxLength`, `stdioMaxBufferSizeMb`, `viewProfile`, …).
- A v1 `registry.<profile>.json` is migrated once and kept as `registry.<profile>.json.migrated-<ts>.bak` (never deleted).
- `~/.dsh/skill-mcp-manager/trash.log` — delete audit.
- Env values may be literals or `$VAR` references to the process environment.

## Future directions

- **MCP Resources & prompts support** — currently only MCP tool calls are supported; other parts of the MCP protocol will be added later.
- Edit each MCP's note (notes) in the UI.
- View and edit SKILLs in the UI.

## License

MIT
