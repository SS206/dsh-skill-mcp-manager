# 本地维护分支（LOCAL FORK）

本目录是 `dsh-skill-mcp-manager`（能力库 / Capability）的**本地维护分支**，由本机维护，**不发布到 npm，也不向上游推送**。

## 来源与分支

- 上游：`https://github.com/alone-tree/dsh-skill-mcp-manager`（MIT），`origin` 保留作只读对照（`git fetch origin` 只取不回推）。
- 基线：上游 `main` @ 1.2.2（`e4a426b`，与 npm 上已发布的 1.2.2 逐字节一致）。
- 本分支：`local`。上游更新对照：`git fetch origin && git log --oneline origin/main -5`。

## 与上游的差异（v2.0.0-local.1）

1. **profile 识别**：以宿主 `ctx.profileContext` 为准（`lib/profile-target.js`），`--profile` 与位置参数只作兜底。上游只认 argv，因此在 DSH Desktop 上会管到 `web` 而不是 `desktop`。
2. **取消接管（v2 破坏性重构）**：插件不再把行吸收进自己的注册表、不再写托管块；补丁层是唯一真源，档位全部用补丁层的 `disabled` 覆盖项表达（常驻 = 不写、按需 = 覆盖 + 本插件的桥惰性启动、关闭 = 只写覆盖）。旧 `registry.<profile>.json` 与托管块在首次启动时一次性迁移并归档为 `.migrated-<ts>.bak`。
3. **跨 profile 静态发现**：`lib/rows.js` 按 `dsh.profile.bundles` 解析每个 bundle 的补丁，任何 profile 的 MCP 清单都能列出来；界面顶部改成「查看 profile」（纯显示视图，`settings.viewProfile`），非运行中的 profile 只读。
4. **不预热的按需桥**：启动与每回合都不连接按需行，只有 `mcp_load` 或界面「刷新快照」才试连；逐工具开关只对按需行有意义。
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
