# 能力库 (Capability) —— dsh-skill-mcp-manager

[English](README.md) | [简体中文](README.zh.md)

一站式SKILL和MCP管理器，面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**宿主级插件，并提供MCP工具按需加载功能，再也不用担心MCP工具太多浪费token啦**

## 页面截图

MCP 管理
![MCP 管理](docs/screenshot-mcp.png)

SKILL 管理
![SKILL 管理](docs/screenshot-skills.png)

## 核心特性

### 1. 一站式可视化管理

安装了哪些 Skill **和** MCP？是否启用？每个SKILL和MCP是什么？都在设置页直接查看，**不用层层翻找**。前端页面直接管理MCP和Skill启停、删除，支持点击SKILL查看原文（使用本地默认的md阅读器）。每个 MCP 工具也可单独启用或禁用，禁用后 AI 无法调用，不影响同服务器的其他工具。

### 2. MCP 按需加载（核心功能，花了好多心思打磨）

会话开始时，on-demand 服务器只暴露**名字 + 简短工具描述**。AI 知道每个工具的存在和功能，但看不到完整 schema。因此：

- **在token账单和完整上下文之间平衡**——只暴露MCP管理器，其他都需要调用工具查看。这会导致AI意识不到有这个东西，进而不会去主动查看有哪些工具可用。但把完整参数发送给AI，又会导致上下文膨胀。本插件将MCP和SKILL一视同仁，提供基础的名字+描述，让AI自己选择调用。
- **没有启动延迟**——服务器只在 AI 真正需要时才连接；
- **不会加载失败导致不可用**——按需加载，失败了非致命（可重试 / 稍后重载）。

### 3. 按会话隔离 MCP 实例

每个 DSH 会话（包括子代理）对同一 MCP 配置各自创建、持有和销毁独立实例：stdio MCP 每个会话一个子进程，HTTP MCP 每个会话一条连接。多个会话并发调用 Playwright 这类有状态工具时，各自操作各自的浏览器页面，**互不覆盖**；会话结束时实例自动回收。eager 工具由每个会话在自己的上下文中注册；MCP 配置（注册表、档位、单工具禁用、密钥、备注）仍全局共享。

### 4. 会话内 MCP 热重载

改了自己的本地 MCP 服务器？在会话里 `mcp_load` 一下即可——重连、重拉工具、新快照。**无需新开会话、无需重启 DSH，对MCP开发极度友好。** 重连只影响当前会话的实例，其他会话不受影响。

### 5. SKILL 多层扫描、外接库、临时隐藏

- **任意深度递归**发现 `<dir>/SKILL.md`——支持连接任意数量的外部技能库目录、支持任意层深度，因此可以进行灵活的SKILL分组。插件只扫描 `<dir>/SKILL.md`，避免把文件夹里的其他文档也扫进来，比如readme.md、reference.md、备份文件.md
- 关闭某技能 = 模型不可见（写 `disable-model-invocation`），但你的 `/name` 斜杠命令**照常可用**。
- 点击删除后整个 `<dir>/` 文件夹移动到回收站。必要时可以恢复。

## 其他辅助特征

为了让各位能用的顺手、放心，本插件还有以下设计

### 6. 只做管理，不接管你的配置

插件不保存、也不改写任何 MCP 定义：每条 `@deepseek-ai/dsh-mcp-client` 行都属于它所在的那一层（profile 的 `cordis.patch.yml`，或某个 bundle 的补丁文件），DSH 原生客户端照常加载它们。插件做的是**发现、展示与按行调档**：

- **常驻**（默认）：什么都不写，由原生 `dsh-mcp-client` 加载；
- **按需**：写一条 `disabled` 覆盖按住原生客户端，改由本插件的桥在会话里启动（省上下文、控制工具面）；
- **关闭**：只写覆盖，无人加载。

三种状态都是补丁层的可逆事实——手动删掉覆盖行就回到常驻；插件被删、被停用也不会影响任何 MCP 的定义。旧的`接管`机制（以及它写入的「托管块」）在 2.0 已移除，启动时会自动把 v1 留下的托管块拆开、把行按原文写回并归档旧注册表。

### 7. 每个 MCP 都能写你的备注

给任意MCP附加一条用户备注，会话目录里会展示给 AI，并且**不被服务器/开发者更新覆盖**。你可以写“A插件挂了就用B插件作为替补”

### 8. 自动预热

安装后插件会连接一次、抓取真实工具名与描述，目录立刻可用。每次加载MCP后都会自动更新缓存。预热和「刷新快照」都是一次性试连，结束即断开，不留运行实例。

### 9. 注册自动校验

`mcp_register` 会**先试连 + 列工具，通过才持久化**——只有配置正确的服务器才会被放行。

### 10. 默认只管理所在 profile，也可手动切换

默认跟随**本次启动的 profile**（读宿主提供的 `profileContext`，不猜命令行）——不越权、不错位；需要时可在设置页把管理目标切到 web / desktop / 其它 profile，切换时自动把旧目标交还原生 MCP 配置并各 profile 独立记账。

## 安装

```bash
dsh plugin --profile <profile> add dsh-skill-mcp-manager
```

再在该 profile 的 `cordis.patch.yml` 加一行（参考 [`cordis.patch.example.yml`](cordis.patch.example.yml)）：

```yaml
- insert:
    - id: skill-mcp-manager
      name: 'dsh-skill-mcp-manager'
      config:
        dataDir: ''            # 空 = ~/.dsh/skill-mcp-manager
        # 留空或 auto = 跟随本次启动的 profile（推荐：插件就管它装进的那个 profile；
        # DSH Desktop 从不传 --profile，profile 目录是位置参数）。
        # 写具体名字 = 安装期默认值；设置页可在运行时切换（存进 settings.json）。
        profile: ''
        trialTimeoutMs: 30000
        toolCallTimeoutMs: 60000
        catalogDescriptionMaxLength: 500
        toolDescriptionMaxLength: 150   # 目录里每条工具的描述截断长度（允许手动修改）
        # importNativeMcp 已废弃（v2 无接管机制），旧配置里出现也不会报错。
```

重启 profile 生效。插件挂在宿主组合里，`mcp_register` / `mcp_load` / `mcp_call` 三件套对该 profile 下所有会话可见；eager 工具由每个会话在自己的上下文中注册，MCP 运行实例按会话独立。

> **表达式说明**：行里的 `!!js …` 加载器表达式会被**求值后**用于本插件启动服务器（按需档），而补丁里永远保留**表达式原文**（任何回写都逐字保留）。无法求值的表达式行仍会列出，但标注"表达式未求值"且不能由本插件启动。

> **卸载说明**：直接删掉插件即可——MCP 定义从来不在插件里。`/mcp prepare-uninstall` 是可选的清理动作，只删除本插件写过的 `disabled` 覆盖项与自己的状态文件，让所有行回到原生加载。

## 使用

### 界面

打开 **设置 → 能力库**（一个设置页，内部「技能 / MCP」两个页签，切换有滑动动画）：

- **MCP 页签**只放两部分：
  - 顶部「查看 profile」行 —— 选择要看哪个 profile 的清单（默认跟随本次运行的 profile）。**只改变显示**：不接管、不交还、不写任何 profile 的配置。查看非运行中的 profile 时是只读的静态视图（行来自它的补丁层与各 bundle 层，没有实时工具数），提示条会说明。
  - 统一清单，按来源分组，三类来源一次看全：
    - **补丁层**：写在 `<profile>/cordis.patch.yml` 里的行。可改档位（常驻 / 按需 / 关闭）、重启、删除条目。
    - **捆绑**：其它 bundle 提供的 MCP（如 exa、calagopus —— 它们的行在各自 bundle 的 `cordis.patch.yml` 里）。可改档位与重启；配置属于该 bundle，本插件不改、也不能删除。
    - **内置**：宿主自带的工具集（computer-use / browser-use），只读。

    档位切换 = **用户补丁层的 `disabled` 覆盖项**（`- id: <id>` + `disabled: true|false`），约 1 秒热生效；按需档的行还可以逐工具开关（常驻行的工具面由原生客户端全量注册，插件无法过滤，开关显示为禁用）；「重启」就地重跑该服务器的连接（`fiber.restart()`），配置不动。「详情」里可看配置、服务器自报元信息与工具清单，「刷新快照」会试连一次并缓存；密钥可打码/显示。
- **技能页签**：所有托管技能（bundle 型 `SKILL.md`）按路径排序 —— 模型可见性开关、系统编辑器打开、跨平台删除；**描述默认折叠**（点「描述」展开）。部署自带技能（`node_modules` / `app.asar` 下）为**只读**。
- **插件级设置**（工具描述截断、stdio 消息上限、模型登记本地程序三档、局域网主机名允许名单）在 **插件列表 → dsh-skill-mcp-manager** 那一页，不占能力库的空间。
### 模型工具面

插件会提供三个恒定小工具，以管理所有的按需加载MCP。

- **`mcp_register`** —— 新增或修改 MCP 条目。试连（30s）+ 列出工具后持久；服务器自报的描述 / 版本 / 标题 / 网站 / 说明自动抓取。可复用它改档位 / 参数 / 备注；只有改连接契约才重连。

  ```text
  mcp_register { name, tier?, transport, command?, args?, env?, cwd?, url?, headers?, notes? }
  ```

  `tier` ∈ `eager` | `on-demand` | `disabled`（默认 `on-demand`）。注意 `eager` 现在是**写入补丁层、由原生 `dsh-mcp-client` 加载**（本插件不再自己常驻注册）。只给 `notes`/`tier` 的调用是"部分更新"，不会重连程序。`notes` 是用户维护、不被开发者更新MCP所覆盖。
- **`mcp_load { name, peek? }`** —— 为**当前会话**加载 / 热重载服务器实例，返回完整工具定义 + 服务器自报元信息；其他会话不受影响。`peek: true` 只读快照，不连接、不掉线，用于当AI忘记MCP工具参数时偷看一眼而不打断MCP工具的生命进程。对于浏览器控制等需要连续操作的MCP尤其友好。
- **`mcp_call { name, tool, args? }`** —— 通过**当前会话**已加载的实例调用某个 on-demand 工具（需先 `mcp_load`）。只传结构化 `args`，不传 shell 文本、不写临时文件。

## 配置

| 字段                            | 默认                         | 含义                                                               |
| ------------------------------- | ---------------------------- | ------------------------------------------------------------------ |
| `dataDir`                     | `~/.dsh/skill-mcp-manager` | 注册表/设置目录（`~/` 会展开）。                                 |
| `profile`                     | `''`（自动）                | **运行**哪个 profile 的行（可写的那一份）。留空或 `auto` 表示跟随本次启动的 profile——DSH Desktop 从不传 `--profile`（profile 目录是位置参数），所以不能靠猜。设置页的「查看 profile」只影响显示，不改变这个运行目标。 |
| `trialTimeoutMs`              | `30000`                    | `mcp_register` / `mcp_load` 的试连超时。                       |
| `toolCallTimeoutMs`           | `60000`                    | 单次 `tools/call` 超时。                                         |
| `catalogDescriptionMaxLength` | `500`                      | 目录里服务器描述的截断长度。                                       |
| `toolDescriptionMaxLength`    | `150`                      | 目录里每条工具描述的截断长度（工具名始终完整显示）。可在 UI 调整。 |
| `importNativeMcp`             | `true`                     | **已废弃**（v2 无接管机制，保留仅为让旧安装配置继续可解析）。 |

## 数据

- **MCP 定义不在插件的数据目录里**：它们就是你 profile 的补丁文件（`<profile>/cordis.patch.yml` 与各 bundle 的补丁）。插件的数据目录只有下面这些。
- `~/.dsh/skill-mcp-manager/agents.<profile>.json` —— 插件私有状态：被本插件代理（按需档）的行、逐工具开关、快照缓存、备注。没有按需行时该文件不存在。
- `~/.dsh/skill-mcp-manager/settings.json` —— 插件设置（`customRecursiveDirs`、`toolDescriptionMaxLength`、`stdioMaxBufferSizeMb`、`viewProfile` 等）。
- 旧版的 `registry.<profile>.json` 在首次启动时迁移并归档为 `registry.<profile>.json.migrated-<ts>.bak`（不删除）。
- `~/.dsh/skill-mcp-manager/trash.log` —— 删除审计。
- env 值可为明文或 `$VAR` 进程环境变量引用。

## 未来方向

- **支持 MCP Resources & prompts** —— 当前只支持MCP的工具调用，后期会扩充MCP协议中的其他内容支持。
- UI 内编辑每条MCP备注（notes）。
- UI 内查看和编辑SKILL。

## License

MIT
