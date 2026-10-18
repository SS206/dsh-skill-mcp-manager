# 本地维护分支（LOCAL FORK）

本目录是 `dsh-skill-mcp-manager`（能力库 / Capability）的**本地维护分支**，由本机维护，**不发布到 npm，也不向上游推送**。

## 来源与分支

- 上游：`https://github.com/alone-tree/dsh-skill-mcp-manager`（MIT），`origin` 保留作只读对照（`git fetch origin` 只取不回推）。
- 基线：上游 `main` @ 1.2.2（`e4a426b`，与 npm 上已发布的 1.2.2 逐字节一致）。
- 本分支：`local`。上游更新对照：`git fetch origin && git log --oneline origin/main -5`。

## 与上游的差异（v1.3.0-local.1）

1. **profile 识别**：以宿主 `ctx.profileContext` 为准（`lib/profile-target.js`），`--profile` 与位置参数只作兜底。上游只认 argv，因此在 DSH Desktop 上会管到 `web` 而不是 `desktop`。
2. **管理目标可切换**：`GET/POST /skill-mcp-manager/profile` + MCP 页「管理 profile」行；切换时旧目标逐字交还、新目标接管、会话实例重建。
3. **注册表按 profile 分账**：`registry.<profile>.json`（旧 `registry.json` 一次性迁移并保留 `.bak-<ts>`）。
4. **Skill 作用域适配 DSH 0.2.0-rc.2**：`agentPresets.acquireScope(id)` 的租约语义取代已删除的 `standingKeyFor()`（`withSkillScope`），预设层技能（`~/.agents/skills`、`~/.dsh/skills`、内置技能）才能列出。

设计细节见 [`docs/DESIGN.zh.md`](DESIGN.zh.md) §4.7 / §5.13 与 [`CHANGELOG.md`](../CHANGELOG.md)。

## 装进 profile（本地 link:）

```powershell
# 依赖（含 peerDeps）
pnpm install --config.auto-install-peers=true

# 装进目标 profile（Windows 上落为 Junction；改源码后重启 DSH 即生效）
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm add "link:D:/ProgramSource/Apps-Agent/DSH/dsh-skill-mcp-manager"
```

回退到市场托管版：`pnpm add dsh-skill-mcp-manager@1.2.2`。

## 测试

发布基线见 [`AGENTS.md`](../AGENTS.md)「开发 / 测试 / 安装」的显式清单（含本分支新增的 `profile-target-smoke` / `profile-switch-smoke` / `skill-scope-smoke`）。注意：本分支不跑上游的 GitHub Actions 发布流。
