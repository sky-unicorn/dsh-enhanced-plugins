# dsh-enhanced-plugins

[English](README.md) | 中文

一个可安装的 DeepSeek Harness bundle，合并四项增强能力：

- **MCP 服务器管理**：在“设置 → 插件”中管理 stdio / Streamable HTTP 服务器；支持修订号栅栏、机密脱敏读取，以及 Claude Code/Codex 一键导入。
- **插件社区**：基于本地快照浏览 DSH 插件，验证 GitHub/npm 安装源，记录市场安装项，在 Host 后台同步渠道，并通过 credentials 服务管理 GitHub Token。
- **文件引用**：在输入框键入 # 搜索当前工作区文件，把有界的 UTF-8 文本快照注入下一次模型请求。
- **产品子智能体开关**：持久控制官方 Claude Code 与 Codex 子智能体 provider，并实时增删相应工具。

四项能力仍各自拥有独立的 Host、Client、Remote、Settings 与 Consumer 生命周期；只共用一个 package manifest、一个 bundle patch 和一个 lazy-CJS 浏览器 bundle。

## 运行要求

- DeepSeek Harness 的公开 ABI 与本地目标 checkout commit 47f943859bef60e4160492346772ded9b24f765a（0.1.0-rc.5）兼容。
- Node.js 22.19 或更高版本。
- 浏览器界面需要 Web profile；不依赖 Web 的 Host 行为仍按各自注入服务是否可用来加载。

官方 DSH 包保持 peer dependency，由 Harness 部署提供。本包不复制或修改 DSH 核心。

## 安装

若 profile 已安装四个原插件，先移除，避免旧 bundle 层残留重复 Client 锚点：

~~~sh
dsh plugin --profile web remove dsh-mcp-server-manager dsh-plugin-market dsh-referenced-file dsh-sub-agent-toggle
dsh plugin --profile web add D:\work\workspace\github\dsh-enhanced-plugins
dsh --profile web --dump-config
dsh web
~~~

从 DSH 源码 checkout 运行时，在命令前加 pnpm。目录或 Git 安装会执行 prepare，构建全部运行时入口；tarball 已包含 lib：

~~~sh
npm pack
dsh plugin --profile web add ./dsh-enhanced-plugins-0.1.0.tgz
~~~

若 pnpm 在 Git 安装时要求构建授权，只在目标 profile 的 pnpm-workspace.yaml 中允许准确包名 dsh-enhanced-plugins，然后重试。

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

根入口有意保持为无行为 Host 插件。浏览器代码把四项能力分别挂成 child fiber，因而不会把可选界面、状态或卸载过程揉成同一个生命周期。

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
