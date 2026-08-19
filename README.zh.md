# dsh-enhanced-plugins

[English](README.md) | 中文

## 项目简介

`dsh-enhanced-plugins` 是一个面向 DeepSeek Harness（DSH）的可安装增强插件合集。它将常用但彼此独立的扩展能力整合到同一个 bundle 中，让用户只需安装和维护一个包，就能完成最后消息重新编辑、MCP 服务配置、模型输入能力声明、插件发现与安装、工作区文件引用，以及产品子智能体开关等操作。

本项目通过 DSH 的公开插件扩展点工作，不修改或替换 DSH 核心。Host 端负责配置、校验、持久化和运行时生命周期，Web Client 提供与 DSH 原生设置界面一致的交互入口；各项能力保持独立装载和卸载，某个可选功能不可用时不会影响其余功能。

它适合希望集中管理常用 DSH 增强能力、减少多个插件分别安装和迁移成本，并保留官方插件架构与升级路径的个人用户和开发者。

## 核心能力

本 bundle 合并六项增强能力：

- **编辑上一条消息**：会话正常结束或被手动停止后，可直接在最后一条已持久化的纯文本用户消息气泡内编辑，从该轮之前截断活动上下文并重新发送。
- **MCP 服务器管理**：在“设置 → 插件”中管理 stdio / Streamable HTTP 服务器；支持修订号栅栏、机密脱敏读取，以及 Claude Code/Codex 一键导入。
- **pi-ai 模型请求类型**：在“设置 → 插件”中把已配置模型声明为“提供方默认”“仅文本”或“文本与图片”，无需修改内置“模型”页面。
- **插件社区**：基于本地快照浏览 DSH 插件，验证 GitHub/npm 安装源，记录市场安装项，在 Host 后台同步渠道，并通过 credentials 服务管理 GitHub Token。
- **文件引用**：在输入框键入 # 搜索当前工作区文件，把有界的 UTF-8 文本快照注入下一次模型请求。
- **产品子智能体开关**：持久控制官方 Claude Code 与 Codex 子智能体 provider，并实时增删相应工具。

各项能力仍分别拥有自身适用的 Host、Client、Remote、Settings 与 Consumer 生命周期；只共用一个 package manifest、一个 bundle patch 和一个 lazy-CJS 浏览器 bundle。

## 运行要求

- DeepSeek Harness 的公开 ABI 与本地目标 checkout commit 47f943859bef60e4160492346772ded9b24f765a（0.1.0-rc.5）兼容。
- Node.js 22.19 或更高版本。
- 浏览器界面需要 Web profile；不依赖 Web 的 Host 行为仍按各自注入服务是否可用来加载。

官方 DSH 包保持 peer dependency，由 Harness 部署提供。本包不复制或修改 DSH 核心。

## 安装

### Windows 10/11 一键迁移

[`scripts/migrate-to-enhanced-plugin.ps1`](scripts/migrate-to-enhanced-plugin.ps1) 兼容 Windows PowerShell 5.1，不依赖 `pwsh` 或 PowerShell 7。它按顺序完成以下操作：

1. 验证安装来源的 `package.json` 确实属于 `dsh-enhanced-plugins`。
2. 在插件目录自动执行 `npm install` 并触发 `prepare`；必要时自动补跑 `npm run build`，然后检查全部公开 `lib` 入口。
3. 查找目标 DSH runner；使用源码 checkout 时先在脚本进程内切换工作目录，让 Corepack 选择 DSH 固定的 pnpm 版本，再读取 profile 的直接依赖。
4. 只卸载仍实际存在的四个旧插件；已经不存在时安全跳过。
5. 从当前 checkout 安装 `dsh-enhanced-plugins`。
6. 确认新插件已成为直接依赖、旧插件均已离开依赖清单，并通过 `--dump-config` 真实加载 Host 入口。

先预览将执行的迁移，不修改 profile：

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\migrate-to-enhanced-plugin.ps1 -WhatIf
~~~

确认后执行默认 `web` profile 迁移：

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\migrate-to-enhanced-plugin.ps1
~~~

指定其他 profile 和 DSH checkout：

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\migrate-to-enhanced-plugin.ps1 `
  -Profile custom `
  -DshCheckout "E:\projects\deepseek-harness"
~~~

脚本参数：

| 参数 | 默认值 | 作用 |
| --- | --- | --- |
| `-Profile` | `web` | 要迁移的 DSH profile 名称 |
| `-DshCommand` | `dsh` | PATH 中的 DSH 可执行命令名或绝对路径 |
| `-DshCheckout` | 自动 | 显式指定 DSH 源码 checkout；指定后通过其中的 `pnpm dsh` 运行 |
| `-PluginPath` | 当前脚本的上级仓库 | 指定要安装的 `dsh-enhanced-plugins` checkout |
| `-WhatIf` | 关闭 | 只显示将执行的迁移，不卸载或安装 |
| `-Confirm` | 关闭 | 执行前要求 PowerShell 交互确认 |

未指定 `-DshCheckout` 时，脚本先使用 PATH 中的 `dsh`；找不到时再查找与本仓库同级的 `deepseek-harness`。使用 checkout 时，脚本会自动进入该目录执行 `pnpm dsh`，并在成功或失败后恢复原目录，因此用户始终可以从插件仓库运行，无需手动 `Set-Location`。`-ExecutionPolicy Bypass` 只作用于本次 `powershell.exe` 进程，不修改系统执行策略。源码仓库名 `dsh-sub-agent` 的实际安装包名是 `dsh-sub-agent-toggle`，脚本已经使用正确名称。

脚本最终输出 `Migrated profile '<名称>' to dsh-enhanced-plugins.` 才表示迁移完成。成功后无需手动执行 `npm install`、`npm run build` 或 `pnpm run build`；如果之前的失败已经把插件加入 profile、但因缺少 `lib` 无法启动，更新后直接重跑本脚本即可自动修复。如果 DSH 已在运行，重启一次后即可正常使用。

### 手动安装与打包

不使用迁移脚本时，可以手动打包后安装。目录或 Git 安装会执行 `prepare`，构建全部运行时入口；tarball 已包含 `lib`：

~~~sh
npm pack
dsh plugin --profile web add ./dsh-enhanced-plugins-0.1.0.tgz
~~~

从 DSH 源码 checkout 执行手动 DSH 命令时，在命令前加 `pnpm`。若 pnpm 在 Git 安装时要求构建授权，只在目标 profile 的 `pnpm-workspace.yaml` 中允许准确包名 `dsh-enhanced-plugins`，然后重试。

## Bundle 条目

本包贡献以下稳定 Loader id：

| Id | 包入口 | 职责 |
| --- | --- | --- |
| plugin-market | dsh-enhanced-plugins/plugin-market | 市场 Host 路由、目录、凭据、安装与同步 |
| mcp-manager | dsh-enhanced-plugins/mcp-server-manager | mcp Settings owner、连接对账与 Remote |
| referenced-file | dsh-enhanced-plugins/referenced-file | 工作区搜索与模型上下文注入 |
| subagent-codex | DSH 官方 provider | Codex 子智能体传输 |
| subagent-claude-code | DSH 官方 provider | Claude Code 子智能体传输 |
| subagent-product-toggles | dsh-enhanced-plugins/sub-agent/host | subagent-products Settings owner 与 Remote |
| subagent-product-toggle-tools | dsh-enhanced-plugins/sub-agent/preset | 实时受控的工具 Consumer |
| ui-enhanced-plugins | dsh-enhanced-plugins | 唯一 Client 模块发现锚点 |

根入口有意保持为无行为 Host 插件。浏览器代码把六项能力分别挂成独立 child fiber，因而不会把可选界面、状态或卸载过程揉成同一个生命周期。pi-ai 请求类型功能不需要新增 Loader 行：现有 Client 发现锚点负责挂载它的浏览器 child，官方适配器仍是 `llm-pi-ai` 的唯一所有者。

## 配置

### 插件社区

cordis.patch.yml 中 plugin-market 行包含：

- profile：安装/卸载的目标 profile，默认 web。
- topic：GitHub 发现 topic，默认 dsh-plugin。
- pageSize：目录分页大小，默认 12。
- operationTimeoutMs：安装/卸载超时，默认 120000。
- githubTokenEnv：凭据引用，默认 GITHUB_TOKEN。
- cliPath：可选 dsh 可执行文件绝对路径；空值复用当前 Node 启动器。

assets/plugins-cache.json 是只读内置渠道。同步后的已验证缓存和市场安装记录保存在 DSH home 的插件市场数据目录下。Token 只经 ctx.credentials 处理，永远不会返回浏览器。

### MCP 服务器

mcp-manager 注册 mcp namespace。Web 卡片支持新增、删除、导入、格式审计，以及 env/header 机密脱敏。Host 负责最终校验，并把每台服务器作为独立 child fiber 对账。浏览器绝不会从脱敏快照重建已有机密定义。

### pi-ai 模型请求类型

只有官方 `llm-pi-ai` settings namespace 正在提供服务时，才会显示“pi-ai 模型请求类型”卡片。它列出 `providers.<route>.models` 下已经配置的模型覆盖，并按下表映射选择：

| 选择 | 存储的模型字段 |
| --- | --- |
| 提供方默认 | unset `input`，继续继承已安装 catalog 条目，再回退到路由默认值 |
| 仅文本 | `input: [text]` |
| 文本与图片 | `input: [text, image]` |

每次变更都通过公开 `settings.mutate` API 携带 descriptor revision，只写入所选路由的完整 `models` 数组；该数组本来就是适配器的整体替换字段。所有未编辑的模型对象及字段都会原样保留。冲突或写入失败后，卡片会重新 describe 最新状态，之后才允许再次编辑。

卡片刻意放在“设置 → 插件”下，因为现有“模型”编辑器没有公开 child slot，Client bundle 纯净度也禁止导入其私有 React 表单。请先在“模型”页面（或 `settings.yaml`）中增删模型覆盖，再在此设置请求类型。能力声明不是端点探测：声明图片能力会允许持久图片准入和 `read_image`，但实际不支持图片的端点仍可能在后续提供方请求阶段拒绝。

### 编辑上一条消息

当前会话不在运行时，最后一条已持久化的纯文本用户消息气泡会在“复制”旁显示“编辑”。点击后，气泡正文原地切换为编辑框；“取消”保持当前会话不变，“保存并重新发送”则提交修改后的文本。会话运行期间完全不渲染编辑按钮，正常结束或手动停止后才会出现。

保存后仍留在当前会话，不创建子会话或新会话。插件把当前模型 surface 从被编辑的用户消息起替换为修改后的内容，再通过同一个 AgentLoop 重新生成；原用户消息及其后的回答、推理和工具过程不会进入这次及后续模型上下文，界面也只显示修改后的气泡与新生成结果。DSH 的底层 Session 日志是追加式的，所以旧事件仍作为审计记录留在原始日志中，而不是物理删除；已执行工具产生的外部副作用也不会被回滚。最后一条用户消息包含图片或其他非文本块时不显示“编辑”，避免重新发送时静默丢失内容。

### 文件引用

referenced-file Host schema 默认值：

| 字段 | 默认值 |
| --- | ---: |
| maxCandidates | 20 |
| maxScannedEntries | 5000 |
| maxDepth | 12 |
| maxReferences | 8 |
| maxFileBytes | 131072 |
| maxTotalBytes | 524288 |
| indexTtlMs | 30000 |
| maxCachedWorkspaces | 8 |

候选遍历会排除常见生成目录；提交时重新解析文件并检查工作区包含关系。二进制、非法 UTF-8、超限、非常规文件或工作区外路径都会被拒绝。

### 产品子智能体

subagent-products namespace 中 claudeCode 与 codex 默认均为 false。每次切换只在修订号栅栏下按路径写入对应布尔值；Consumer 随即挂载或释放相应的官方 dsh-tool-subagent，无需重启 profile。

若只想让指定 Agent preset 获得这些工具，应禁用或删除根层的 subagent-product-toggle-tools 行，再只在目标 preset 中挂载 dsh-enhanced-plugins/sub-agent/preset。同一 scope 不要同时采用两种布局。

## 开发

仓库规则要求的固定 sibling checkout：

~~~text
D:\work\workspace\github\deepseek-harness
~~~

类型检查读取其中的当前公开声明；运行时构建仍只导入公开包名，安装期构建不依赖 sibling checkout：

~~~sh
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
~~~

浏览器 bundle 使用 CSS Modules，且只消费 DSH 的 --dsw-alias-* 语义主题 token，因此会自动跟随浅色、深色和系统外观，不包含功能自有的主题分支。
