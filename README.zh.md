# dsh-enhanced-plugins

中文 | [English](README.md)

面向 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的增强功能套件：**6 个可独立安装的 Cordis bundle + 1 个 Windows Companion**。

- 不修改 DSH 核心，只使用公开插件扩展点。
- 可一次安装全部功能，也可只保留选中的独立功能。
- Host、Web Client 与 Windows Companion 各自保持清晰的生命周期和安全边界。

[功能一览](#功能一览) · [快速开始](#快速开始) · [功能指南](#功能指南) · [兼容性与迁移](#兼容性与迁移) · [配置参考](#配置参考) · [开发与验证](#开发与验证)

## 功能一览

安装脚本只需要“安装名称”；每项功能也都有自包含的独立发布包。

| 功能 | 安装名称 | 独立包 | 平台与入口 | 解决什么问题 |
| --- | --- | --- | --- | --- |
| [Windows Launcher](#1-windows-launcher) | `windows-launcher` | `dsh-enhanced-windows-launcher` | Windows 开始菜单 | 用托盘控制 Web、Headless、Profile、源码构建与诊断 |
| [桌面提示与宠物](#2-桌面提示与宠物) | `notification` | `dsh-enhanced-notification` | Windows；设置 → 桌面宠物 | 任务提示音、自定义 WAV 音效库和原生动态桌宠 |
| [插件社区](#3-插件社区) | `plugin-market` | `dsh-enhanced-plugin-market` | Web；设置 → 插件社区 | 搜索、安全预检、安装和卸载社区插件 |
| [MCP 服务器管理](#4-mcp-服务器管理) | `mcp-server-manager` | `dsh-enhanced-mcp-server-manager` | Web；侧栏插件 → 所属包 → 组件配置 | 管理 stdio / Streamable HTTP MCP 服务器并导入本机配置 |
| [编辑上一条消息](#5-编辑上一条消息) | `edit-last-message` | `dsh-enhanced-edit-last-message` | Web；最后一条用户消息 | 修改该轮内容并在当前会话重新生成 |
| [产品子智能体](#6-产品子智能体) | `sub-agent` | `dsh-enhanced-sub-agent` | Web；设置 → 子智能体 | 实时启用或停用 Claude Code / Codex 工具 |
| [官方团队监控](#7-官方团队监控) | `agent-team-monitor` | `dsh-enhanced-agent-team-monitor` | Web；当前对话输入框右侧团队图标 | 按角色查看执行中／历史子会话，跳转原生详情，以及 Team 任务依赖和邮箱计数 |

聚合包名为 `dsh-enhanced-plugins`。省略功能选择时，安装脚本会组合上表全部 7 项；选择功能时只安装对应独立包或 Companion。

## 快速开始

### 7.2.3：适配 DSH 0.1.6-alpha.2

- 修复 Launcher 启动 DSH 后工具调用出现 `Cannot read properties of undefined (reading 'prepare')`：绑定源码 checkout 时，Web、Headless 和 Profile 通过构建后的 `apps/cli/lib/bin.js` 启动，避免 `tsx` 混用源码与构建模块。更新后需重新安装 Launcher 并重启 Web。

- 插件 `7.2.3` 验证的 DSH 版本为 `0.1.6-alpha.2`，源码基线为 `ddefc45fbc7f8e46dd73185e68295696d1297887`。远端表缺少当前插件或 DSH 版本时，安装器会继续查包内兼容表。当前支持范围统一维护在 [`dsh-compatibility.json`](dsh-compatibility.json)。
- `model-input-types` 已退役：官方 DSH 在“设置 → 模型 → 自定义设置 → 模型选项”中提供逐模型的“文本／图片”输入类型设置。更新安装会移除旧独立包；已有模型设置由官方设置系统保留。
- MCP 配置位于侧栏“插件”页所属组件的配置入口；离开页面时丢弃未保存草稿。独立安装和聚合安装均提供入口。
- 团队监控通过新版 `mainView` 会话引用识别主会话，成员跳转使用官方 `uiWorkspace.openSession()`；侧栏独立保留的子会话不会改变主会话监控。6 个独立功能包和 Windows Launcher 使用同一发布版本与源码基线。
- 类型检查拒绝缺少新版插件配置／会话引用接口的旧 DSH 构建产物。
- Launcher 减少切页、滚动和功能筛选的重复布局，切换启动方式后及时刷新按钮文案；执行日志按功能只保留最新一轮，并限制界面读取量。
- Launcher 概览顶部可选择“浏览器”或“源码桌面”，选择会保存，登录自动启动也遵循此选择。旧配置默认仍为浏览器。
- 源码桌面复用已绑定的 DSH checkout 和 Launcher 工具链：“启动桌面端”运行 `pnpm run start:desktop`，“构建并启动”运行 `pnpm run dev:desktop`。缺少构建产物时禁用普通启动并提示构建；源码依赖需先通过 `pnpm install --frozen-lockfile` 安装。启动过程、失败原因和退出码进入桌面日志；“停止”只结束 Launcher 拥有的命令进程树。构建并启动仍在运行时，禁止同时启动 Web 读取共享产物。旧的 `DesktopExecutable` 字段不再使用，无需选择 EXE。
- 官方源码命令每次重建 `apps/desktop/.desktop-build/development/project`，数据默认位于同级 `home`，或使用继承的 `DSH_HOME`；默认关闭 DevTools，显式设置 `DSH_DESKTOP_OPEN_DEVTOOLS=1` 可打开。源码模式禁用官方包管理 UI，目前没有公开参数继承 Web bundles，Launcher 不向生成的 profile 私自复制插件。打包后的 Desktop 应用则独立管理保留的 `desktop` profile，仍不能通过 `dsh plugin --profile desktop` 操作。
- 编辑消息在持久化 inbox 恢复后仍按替换处理；目标已离开上下文或身份不匹配时明确失败，不把编辑悄悄改为普通追加。

### 前置条件

- Node.js 22.19.x，或 Node.js 24 及更高版本。
- 可从源码运行的最新 DSH Web profile；可先阅读 [DSH Web UI 入门](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart)。
- 支持的 DSH 源码基线为 [`0.1.6-alpha.2`](https://github.com/deepseek-ai/deepseek-harness/tree/ddefc45fbc7f8e46dd73185e68295696d1297887)，后续验证通过的版本可追加到 [`dsh-compatibility.json`](dsh-compatibility.json)，无需发布新的插件代码。
- 此版本 DSH 的 Session 文件锁已不再依赖 `fs-ext`。原生构建要求以目标 checkout 为准；Launcher 自身使用系统 .NET Framework 的 `csc.exe`。不要跳过依赖安装脚本。
- Windows Launcher、原生提示音和桌面宠物需要带 Windows PowerShell 5.1 的完整 Windows 桌面版本，即 Windows 10 1607 或更高版本，或 Windows 11。所需系统能力在 Home、Pro、Education / Pro Education 与 Enterprise 上相同；Windows S 模式、IoT / 精简版本以及 Windows 10 1507、1511 不在这一基线内。已经超出微软生命周期的 Windows 功能更新只能尽力兼容，因为所需 Node.js 工具链不保证支持已停止维护的操作系统。安装器不依赖某一个特定的 `tar.exe`；其余功能可跨平台使用。

> [!IMPORTANT]
> DSH 仍处于开发者预览阶段。升级 DSH 后若出现兼容问题，请先核对上面的实测版本和 commit。

> [!CAUTION]
> **先确认 DSH 与插件仓库的目录关系，再复制安装命令：**
>
> - **同目录安装：** 两个仓库位于**同一父目录**，直接使用下方命令。
> - **非同目录安装：** 两个仓库位于**不同父目录**，命令必须额外传入 `-DshCheckout "DSH 源码绝对路径"`。

### 安装全部功能

当两个仓库位于同一父目录时，在本仓库根目录运行：

```text
<工作目录>/
├── deepseek-harness/
└── dsh-enhanced-plugins/
```

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\migrate-to-enhanced-plugin.ps1
```

省略 `-Features` 或传入 `-Features all` 会安装 6 个**独立** Cordis 功能包和必选的 Windows Launcher，不再用根聚合包表示“全选”。Launcher 位于 `%LOCALAPPDATA%\DeepSeekHarness\Launcher`，默认只创建开始菜单快捷方式；需要桌面快捷方式时添加 `-CreateLauncherDesktopShortcut`。直接运行安装脚本只安装或更新程序文件，不会自动启动或打开 Launcher；从 Launcher 内执行自更新时仍会完成必要的版本重启和就绪检查。

如果 DSH checkout 不在同级目录，显式指定它：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\migrate-to-enhanced-plugin.ps1 `
  -DshCheckout "E:\projects\deepseek-harness"
```

### 按需安装

先查看当前版本提供的稳定安装名称：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\migrate-to-enhanced-plugin.ps1 -ListFeatures
```

再传入最终希望保留的功能集合。例如，只安装桌面提示、MCP 管理和编辑消息：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\migrate-to-enhanced-plugin.ps1 `
  -Features notification,mcp-server-manager,edit-last-message
```

常见组合可直接替换命令中的 `-Features` 值：

| 目标 | 功能集合 |
| --- | --- |
| Windows 桌面体验 | `windows-launcher,notification` |
| Agent 增强 | `mcp-server-manager,edit-last-message,sub-agent` |
| 插件发现与集成管理 | `plugin-market,mcp-server-manager` |

`-Features` 不是“额外添加列表”，而是目标 Profile **最终保留的本项目功能集合**。Windows Launcher 是全局必选组件，不需要写入列表，也不能通过功能选择卸载；`-Features none` 只清空当前 Profile 中本项目的功能包并保留 Launcher。脚本会：

1. 安装依赖并构建全部所选功能。
2. 安装并验证所选 bundle / Companion 能否加载。
3. 成功后再移除聚合包、未选择的同仓库功能和已声明冲突的旧包。
4. 检测并清理已经退役的文件引用插件。

安装器会先将所选 bundle 打包，再安装到 Profile 内，避免源码目录链接使 DSH 构建入口无法解析插件依赖。按内容哈希命名的 tarball 保存在该 Profile 的 `.dsh-enhanced-bundles` 目录，供 pnpm 后续重装使用；请勿在仍被 Profile 引用时删除。重新安装会替换旧的源码链接。

### Launcher 插件管理

安装脚本会把 DSH checkout、本项目源码路径、Git remote/ref、源码 revision 和每个已管理 Profile 的目标集合写入 `%LOCALAPPDATA%\DeepSeekHarness\Launcher\install-state.json`。控制中心的“插件管理”页据此提供：

- 从各 `packages/*/package.json` 动态生成的功能列表，新增普通功能无需修改 Launcher；
- 首次默认全选、按 Profile 选择、单项安装/卸载、历史聚合包迁移；
- Git 工作区先按插件远端 URL 解析 Windows 系统代理；系统选择代理时，仅通过 Git 单次命令配置应用于带退避重试的安全 `fetch`，操作结束后自动失效且不修改既有 Git 配置。连接重置时自动改用 HTTP/1.1 重试，成功后仅在本地执行 `merge --ff-only`，避免 `pull` 再次访问网络；或没有 Git 时下载准确 commit 的源码 ZIP；无网络时也可手动绑定源码目录或导入源码 ZIP；
- 只有源码 revision 或目标功能发生变化时，才在 `sources/runtime-*` 持久化隔离快照中执行 `npm ci`、正式 `npm run build` 和 runtime entry 校验；将构建后的包打成 tarball 安装到 Profile 内，未被任何 Profile 引用的旧源码快照会安全清理；开发期的全仓类型检查仍在源码目录运行，不会因 sibling DSH 类型路径阻止安装；npm 的 stderr 警告保留在日志中，是否失败只看真实退出码；全部完成后才停止 Launcher-owned DSH 并提交更改；
- Launcher 哈希变化时由外部协调器切换版本、等待新版就绪、失败回滚，并恢复此前运行的 DSH；DSH 连续保持 Launcher-owned 状态 15 秒后才报告恢复成功；
- Launcher 重启后继续跟踪仍在运行的协调器；异常中断或状态文件损坏时保留日志/备份并从实际 Profile inventory 重新读取状态。

第一版只支持本地 DSH 源码 checkout 和本项目源码安装，不支持 npx、全局 `dsh`、npm 发布包或 GitHub Releases。Git 工作区有修改、本地领先或发生分叉时不会 reset、rebase 或覆盖用户改动。

任何前置步骤失败时，脚本都不会提前破坏原有可用组合。安装成功后如果 DSH 正在运行，重启当前 Web profile 一次。

## 功能指南

### 1. Windows Launcher

`windows-launcher` · **开始菜单 → DeepSeek Harness Launcher** · Windows 10+

![DeepSeek Harness Windows Launcher 概览](assets/readme/windows-launcher.png)

独立于 Cordis 插件树的 Windows 控制中心，适合不想长期守着终端的本地 DSH 用户。

- **Web 控制：** 查看状态，启动、打开、重启或停止 Web；识别外部端口服务并拒绝越权接管。即使关闭了启动时自动打开浏览器，“打开页面”也会使用当前 Launcher-owned DSH 进程的认证入口，启动 token 不会写入 Launcher 日志。
- **任务与 Profile：** 运行 Headless 单次任务和后台 Profile，统一保存 UTF-8 结果与日志。
- **CLI 启动入口：** 绑定源码 checkout 时使用已构建的 `apps/cli/lib/bin.js`。NVM 运行参数和系统模式的托管启动脚本均使用此入口；构建产物缺失时提示先构建 DSH。更新或修改 DSH 源码后，需要完成构建再启动。源码构建与官方桌面启动仍使用各自的流程。
- **Web 运行环境：** 概览在标题旁提供紧凑的“浏览器／源码桌面”分段切换，将服务状态与主要操作合并在同一张浅色卡片内，下方依次展示运行环境和启动选项。切换支持左右方向键，窄窗口中的操作按钮会缩排为一行或均衡的两行。运行环境展示 NVM 沙盒/系统模式、Node 与 npm/pnpm/Yarn 的需求及实际版本、检测来源和准备/失败状态。“Node 版本选择”提供“自动选择（最高兼容版本）”和已安装的 NVM 版本；选择后自动保存，供后续 Web／源码桌面启动、DSH 构建和插件源码操作使用，旧设置默认自动选择。“重新检测”可刷新已安装版本列表。手动版本仍须满足项目要求，未安装或不兼容时直接报错，不自动换版本；已保存但被卸载的版本会标注“未安装”，可重新选择或切回自动。运行中显示本次启动记录，切换选择不会重启已有进程，外部服务版本不会被猜测。

  每次启动 Web（含托盘、重启、登录自动启动）都会检测 nvm-windows。已安装时，从绑定的 DSH checkout 或可识别的 npm DSH shim 读取元数据：Node 按 `.nvmrc`、`.node-version`、`volta.node`、`engines.node` 选择，并始终满足 `engines.node`，自动模式使用 NVM 已安装的最高匹配版本，手动模式只使用已保存的版本。包管理器优先读取 `packageManager`/`devEngines.packageManager`，再参考 Volta、engines 和锁文件；锁文件只标识工具种类或 Yarn 主版本系列，不被当作精确版本。缺少的包管理器在首次启动时下载到 Launcher 的 `sandbox` 目录，后续复用；声明冲突会明确报错。

  沙盒直接用所选 Node 调用同一个 DSH CLI，仅隔离该服务的 PATH、npm/Yarn 全局安装目录及 npm/Yarn/Corepack 缓存，不执行 `nvm use`，不修改系统 Node、NVM 链接或 DSH 源码。pnpm 保留用户／项目配置及原有 store 位置，以复用源码和 Profile 已安装的依赖。Launcher 和候选安装器只清理由旧版本传入、且位于 Launcher 沙盒内的存储覆盖；安装器退出时恢复调用方环境。这是工具链的进程级隔离，不是文件或网络权限沙箱。未检测到 NVM 时保留原启动方式；NVM 中缺少匹配 Node、项目声明无效或下载失败时停止启动并显示原因，Node 需先用 `nvm install` 安装。无法识别的自定义启动器需重新绑定 DSH 源码。DSH 源码构建和插件源码操作复用概览的 Node 选择与沙盒，包括 DSH 声明的 pnpm 和该 Node 内置的 npm。DSH 拉取后会在清理前重新检测，构建检测不要求依赖或 CLI 产物已存在。插件操作在 npm ci、构建、停止 DSH 或安装 Profile 前校验候选源码的 Node/npm 要求；不兼容时直接报错，不另选 Node。构建／更新日志记录所选运行环境。未检测到 NVM 时，自动模式仍使用系统工具链；已保存的手动选择会报错，直到恢复 NVM 或切回自动。Headless、其他 Profile 沿用原有流程。
- **源码维护：** “更新源码并构建”对绑定的 DSH checkout 执行 `git pull --ff-only`，成功后依次运行 `pnpm run clean`、`pnpm install --frozen-lockfile`、`pnpm run build`。拉取 HTTP(S) 远端前，Launcher 会按远端 URL 解析当前 Windows 系统代理；若系统为该地址选择了代理，则仅通过 Git 的单次命令配置应用到本次拉取，命令结束（包括失败）后自动失效，不会写入或覆盖仓库、用户或系统级 Git 代理设置。SSH 远端不使用这项 HTTP(S) 代理发现。“仅构建”直接使用当前本地源码，跳过 Git 更新，仍执行这三个 pnpm 步骤；无 Git 时，“更新源码并构建”也可经确认跳过拉取。操作期间两个构建按钮均禁用，避免重复启动。清理前会检查 checkout 是否具备 clean/build 脚本和锁文件，以及 pnpm 是否可用。任一步失败即停止后续步骤，锁文件错误不会降级为非冻结安装。Git 进度和 pnpm 警告不会被误判为失败，操作以真实退出码为准。页面会区分拉取、清理、依赖安装、构建与环境错误，放大的日志文字和“打开日志目录”入口便于排查；完整 UTF-8 输出、命令引擎错误及最终结果保存在 `logs/dsh-build.log`，刷新或重新进入页面不会丢失。运行前请先停止使用此 checkout 的 DSH：清理会删除现有构建产物，后续步骤失败时旧产物不会恢复。本操作不会自动停止或重启 DSH，请在构建成功后手动启动服务。

  源码操作进程会临时设置 `pnpm_config_verify_deps_before_run=false`，防止 pnpm 的[脚本前自动安装](https://pnpm.io/settings/build#verifydepsbeforerun)在明确的冻结安装步骤前改写锁文件；不会修改仓库或全局 pnpm 配置。

- **诊断：** 汇总命令、端口、工作目录、运行状态和日志，并提供独立的 DSH 源码页。
- **桌面体验：** 系统托盘、可选登录启动、各尺寸统一的居中纵向布局、逐显示器 DPI 缩放，以及不受 Windows 主题影响的统一圆角页面与文本区域滚动条；日志与诊断、任务输入/输出、源码构建日志和插件运行日志均使用相同样式，并支持滚轮、触控板、拖动、轨道翻页与键盘滚动。所有日志视图会过滤文本框无法解释的 ANSI／ECMA-48 终端控制序列，保留可读内容且不改写原始 UTF-8 日志文件。Launcher 会记住最后使用的显示器和正常窗口位置，显示器拓扑或工作区变化后会自动收回可见区域。

<details>
<summary><strong>进程所有权、退出与后台行为</strong></summary>

Launcher 只停止自己启动的 DSH 进程树。端口上出现外部 Web 服务时会显示“外部 Web 服务”，允许打开页面，但不会接管、重启或终止它。

系统托盘提供两个退出动作：“仅退出 Launcher”会保留 DSH 服务；“退出 Launcher”会先请求安全停止 Launcher 自己管理的服务。若检测到外部服务或停止超时，退出会被取消并说明原因。

任务与 Profile 均通过无控制台窗口的子进程运行。用户任务经 UTF-8 请求文件传给 PowerShell 命令引擎，不会拼接进 `cmd.exe`；隐藏主窗口后会停止前台轮询，但托盘和后台服务仍继续工作。

Web、源码桌面、源码构建和每个 Profile 各自只保留最新一次执行日志；新一轮开始时覆盖上一轮，同一次执行中的各阶段输出、错误和退出码仍写在一起。Launcher 自身日志在新实例取得单实例锁后覆盖，唤起已有窗口不会清空；更新清理日志也只保留最近一轮，插件更新继续复用 `updates/current`。正在执行的日志不会被另一轮覆盖。Headless 输出在任务结束后显示，下一次任务会替换它。

日志页和构建日志的每次读取最多访问文件末尾 256 KiB，再提取所需行数，避免当前运行产生的大日志在切页或刷新时阻塞界面；读取不改写本轮日志。页面滚动不触发布局，功能筛选复用现有行并保留选择，全选与清空只更新一次变更摘要。切换启动方式会刷新按钮文案，无需滚动页面。

</details>

<details>
<summary><strong>登录启动、部署与源码绑定</strong></summary>

登录启动默认关闭。可选择“只启动 Launcher 到托盘”或“先启动 Launcher，等待 30 秒后再在后台启动 DSH Web”，两种模式互斥，也可以全部关闭。

程序使用版本化目录部署，开始菜单和登录启动项在升级后都会指向新版本，不依赖 profile 内的 `node_modules`。安装器保留用户显式配置的 DSH 命令；使用本地 DSH checkout 安装时，则生成并验证直接调用该 checkout CLI 的安全入口，并将它记录为唯一允许执行源码构建的根目录。

设置、运行状态、安装状态、更新请求与日志统一位于 `%LOCALAPPDATA%\DeepSeekHarness\Launcher`。托盘更新和应用插件变更复用固定的 `updates\current` 工作目录；下一次操作开始前会清理其中的旧请求、结果、日志和源码 ZIP，只保留最近一次操作记录。更新协调器仍在运行时不能覆盖该目录，Launcher 重启后仍会继续跟踪操作。打开控制中心读取安装状态后，以及更新操作结束后，会在后台自动删除旧版本不再使用的 GUID 更新目录，包括其中的构建文件、`node_modules` 和日志；仍有协调器运行、被源码绑定或任意 Profile 引用的目录会保留，稍后打开控制中心或更新结束时再次检查。旧更新目录中的源码绑定会在成功安装时迁移到 `sources` 快照；活动插件快照仍由 `sources` 管理。清理支持长路径，不跟随目录链接；无法确认安全或删除失败时保留目录并记录日志，不影响已成功的安装。Launcher 在管理页中始终必选；控制中心不提供自卸载按钮，需要移除程序文件、快捷方式和登录启动项时，在项目源码中运行 `migrate-to-enhanced-plugin.ps1 -UninstallLauncher`。日志与用户设置默认保留。

</details>

### 2. 桌面提示与宠物

`notification` · **设置 → 桌面宠物** · 提示音与宠物仅支持 Windows 10+

![桌面提示、自定义音效库与宠物设置](assets/readme/desktop-notifications.png)

- “需要确认”“任务完成”“任务受阻”三类事件可分别关闭，或选择两档默认音 / 自定义 WAV。
- 切换音效会自动试听，也可手动试听；共享增益为 0–100%，100% 约为 +6 dB，并对接近峰值的 PCM / IEEE Float WAV 软限幅。
- 单文件最多 2 MiB，公共音效库最多 64 个文件，全部保存在当前 DSH profile 中。
- 桌宠可选“平面小鲸”“立体小鲸”或“鲸鱼娘”，设置实时生效。

| 汇总状态 | 桌宠表现 |
| --- | --- |
| 空闲 | 睡眠循环；鼠标接触或拖动时切换为互动动作，可选择空闲时不置顶 |
| 任务中 | 专注游动或操作任务面板 |
| 需要确认 | 惊讶、转头或问号提醒，优先级最高 |
| 已完成 | 仅为顶层任务短暂播放庆祝动作 |
| 任务受阻 | 仅为顶层任务短暂播放疲惫或担心动作 |

桌宠可跨显示器拖动，并按显示器保存归一化位置；分辨率、缩放、工作区或显示器连接变化后会重新换算到可见区域。修改启动角落会清除拖动记录。桌宠不会出现在任务栏或 Alt+Tab 任务切换器中；需要隐藏时请在设置中关闭桌宠。Windows 开启“减弱动画”后，每种状态会使用代表静态帧。

常驻宠物和短生命周期提示音进程都由 DSH subprocess service 管理，关闭功能时会协作式退出；Ctrl+C、插件重载或正常关闭期间的 companion 管道断开会按正常清理处理。若旧配置保存了已经退役的已知桌宠 ID，下次启动会迁移为“平面小鲸”；其他未知值仍会校验失败。

### 3. 插件社区

`plugin-market` · **设置 → 插件社区**

![插件社区页面](assets/readme/plugin-community.png)

1. 首次打开使用内置快照；“同步最新索引”通过 ETag 获取 GitHub Actions 每 6 小时发布的校验快照，短暂的 429/502/503/504 会自动重试。
2. 可按仓库名、包名、描述或 topic 搜索；安装前先实时预检仓库身份、commit 和发布结构。
3. 只有身份匹配且不含安装生命周期脚本的 npm bundle 才提供“一键安装”。可验证的无构建源码 bundle 可在确认后固定 commit 安装；其他情况只显示安装说明。
4. 安装与卸载作为可取消后台任务执行；完成后验证目标 profile、bundle patch 和组合，失败自动回滚。
5. “已安装”页会区分市场管理的插件和外部管理的插件；只有前者可以从此页卸载。

<details>
<summary><strong>索引发布、网络代理与凭据</strong></summary>

索引由 [`.github/workflows/update-plugin-index.yml`](.github/workflows/update-plugin-index.yml) 生成到 `market-index` 分支：完整枚举 topic，只重新验证新增或变化的仓库；异常缩水或生成失败不会覆盖上次结果。插件市场自身是内置的已验证渠道贡献，即使远程镜像尚未收录也会出现，后续不会重复。

内置快照和自动索引同步都不需要 GitHub Token。Host 下载使用 这两个受支持 DSH 版本安装的全局传输，遵循其代理校验、直连和 `NO_PROXY` 规则。`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 与 `NO_PROXY` 可在启动环境或 `$DSH_HOME/.env` 中设置；插件市场不再自行创建或关闭代理 dispatcher。安装预检若遇到 GitHub API 限流，可在“配置”中保存只读、短有效期的 Fine-grained Token；Token 只发送到本机 DSH Host，并由 credentials 服务保存。

页面会显示索引生成时间；超过 24 小时未更新时明确提示，同时继续保留上次可用快照。

</details>

### 4. MCP 服务器管理

`mcp-server-manager` · **侧栏插件 → dsh-enhanced-mcp-server-manager → 配置 mcp-manager**

![MCP 服务器管理](assets/readme/mcp-server-manager.png)

1. 点击“添加服务器”或已有服务器的“编辑”，在弹窗中设置名称、连接方式和配置；取消或按 Esc 可关闭弹窗并放弃其中的修改。
2. `stdio` 配置命令、参数、工作目录和环境变量；HTTP 配置 HTTP(S) URL 与请求头。两种连接方式均可设置工具调用超时。
3. 也可由 Host 一键导入本机 Claude Code 与 Codex 配置；重复项会跳过，无法安全转换的项目会说明原因。
4. 在弹窗中点击“添加”或“应用修改”将该服务器放入页面草稿；检查卡片顶部的格式审计后，再点击页面的“保存”。Host 按服务器分别启动、更新或卸载连接。

浏览器读取已有服务器时会掩码环境变量与请求头；编辑时保留掩码即可沿用原值，输入新值可替换，移除对应行可删除。修改变量或请求头名称时需要同时输入新值。Host 在未脱敏的原配置上应用修改，未修改的机密不会从脱敏快照重建或覆盖。切换连接方式会舍弃旧方式的环境变量或请求头。

直接写在 `cordis.yml` 组合层的服务器可以编辑同名字段；由于 DSH 设置的继承规则，不能从本页面改名或移除，Host 会在写入前拒绝这些操作。

草稿绑定开始编辑时的配置版本。其他页面或外部编辑更新配置后，旧草稿保存会被拒绝，不会删除对方新增的服务器；请离开页面丢弃草稿，再重新打开、查看最新配置后编辑。只有点击保存才提交 MCP 草稿。连接中断时会退出保存状态并保留草稿，写入失败后重新读取 Host 配置；较早的读取响应不会覆盖较新的刷新结果。

### 5. 编辑上一条消息

`edit-last-message` · **当前会话最后一条可编辑的用户消息气泡**

![编辑上一条消息并重新发送](assets/readme/edit-last-message.png)

1. 等待当前会话结束，或先停止正在运行的会话。
2. 点击“编辑上一条消息”，在气泡内修改文本。
3. 点击“重新发送”或按 `Ctrl/⌘ + Enter`；按 `Esc` 或“取消”退出编辑。

重新发送仍在当前会话内完成：插件从被编辑的用户消息开始替换当前模型上下文，再通过同一个 AgentLoop 生成后续内容。DSH Session 日志保持追加式审计记录，已经执行的工具副作用不会回滚。上传的通用文件继续使用 DSH 文件卡呈现；包含任意附件或其他非文本块的消息不会提供编辑入口，以免静默丢失内容。

保留已发送引用预览：点击文件标签或该步骤实际加载的 Skill 标签，会在当前会话右侧栏打开预览，不修改文本或重新发送。编辑后的气泡也提供文件预览；Skill 标签只使用编辑所属步骤的调用记录，不沿用被替换轮次的记录。重新发送继续使用插件来源，斜杠文本本身不会被当作新的用户 Skill 调用。

6.1.0 起使用 V3 的替换字段与标准插件来源格式，只保存原始消息 ID，不再嵌入事件序号，避免迁移重编号导致编辑位置错误。早期嵌套标记及 5.x 的独立 `edit-last-message` 来源均不被 V2→V3 迁移接受。升级后打开这类旧会话前，请先停止所有 DSH Host，对受影响的日志执行离线修复：

```powershell
node .\scripts\repair-edit-last-message-session.mjs "C:\path\to\session.jsonl.zstd"
node .\scripts\repair-edit-last-message-session.mjs --write "C:\path\to\session.jsonl.zstd"
```

第一条命令只检查，不写文件；第二条命令将两代旧编辑标记转换为标准插件来源，并在同目录创建带时间戳的原始文件备份。截断、损坏、格式不符或检查期间发生变化的日志都会被拒绝，不会静默重写。

### 6. 产品子智能体

`sub-agent` · **设置 → 子智能体**

![Claude Code 与 Codex 子智能体开关](assets/readme/subagent-toggles.png)

打开 Claude Code 或 Codex 后，变更会立即应用到加载了本控制插件的 Agent preset，包括正在运行的会话；关闭开关会实时移除对应工具。本机仍需安装对应产品及其官方 DSH provider。

两个开关默认关闭。写入使用 path-addressed 操作和设置修订号，不会用脱敏或过期快照覆盖其他页面及外部编辑产生的新值。

### 7. 官方团队监控

`agent-team-monitor` · **当前对话输入框右侧 → 团队图标**

![官方 Agent Teams 只读监控面板](assets/readme/agent-team-monitor.png)

- 入口属于当前会话，在输入框右侧的模型／上下文控件同组显示。检测到工作流、Agent Teams 或原生子代理会话后才出现团队图标；点击才展开，切换会话立即关闭并清除旧数据，不注册全局浮层或标题栏按钮。没有子代理／团队活动的普通对话不显示入口。
- “角色与子代理会话”按已记录的成员名／创建标签分组，同名角色的多次创建保留为不同会话；没有标签时单列“未标注角色”，不从提示词或会话标题猜测身份。可筛选“全部／正在执行／历史会话”，查看会话标题、ID、模式、创建时间和状态。目录包含当前会话下的子代理及更深层子会话，不跨到其他会话树。
- 点击可用会话行，会按真实父子 ID 和原生目录模式调用 DSH 的 `openSubagent`，进入与原生下拉列表相同的详情页面。历史、正在执行、嵌套会话均可跳转；点击前重新核对目录，切换会话或插件卸载后不执行迟到跳转。损坏／缺失的记录显示不可用，不伪造空会话。
- 标准 `workflow` 与实验性 Agent Teams 是两套机制，分别展示，不再把“Agent Teams 未启用”误当成没有工作流成员。工作流从当前会话自己的 `tool-workflow/*` 持久事件读取运行名称、实际启动的成员、阶段及完成／失败／取消状态；不会推测脚本未来的角色、任务依赖或邮箱。成员按 `runId + seq` 配对，fork 继承的父会话工作流不会串入新会话。
- Agent Teams 面板跟随当前队长或 roster 成员会话，显示成员状态、任务依赖/负责人/可领取状态、写入范围重叠提示和待投递消息数量。点击任务查看详情，点击成员打开官方子代理会话。
- Host 读取官方 `ctx.agentTeams`；冷历史由官方 Agent Teams 运行时注册的 `agentTeam` 投影和公开 `ctx.sessionProjections.restore()` 回放。日志通过不提交恢复的 `sessionQuery.observeSession()` 读取，不激活 Agent，也不创建第二份团队状态。
- 只轮询当前会话（展开时 1.5 秒、收起时 5 秒）；隐藏页面或断线后暂停。后续启动的成员和状态变化会自动刷新，但不会自动打开面板。点击图标、外部区域或 Escape 可收起。切换会话、重连和请求失败不会把旧数据显示为实时状态。
- 监控插件**不会启用 Agent Teams 或 workflow**，不注册模型工具，不创建/唤醒/中断成员，不编辑任务或调度工作。查看标准工作流无需实验性 Team 包；要查看 Agent Teams 的实时或历史状态，请按[官方 Team 文档](https://github.com/deepseek-ai/deepseek-harness/tree/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/experimental/agent-team)单独启用实验性运行时，使其拥有并注册投影。
- 使用兼容表中已验证的 DSH 源码 ABI。实验包不由本插件打包或从 npm 获取；Agent Teams 历史回放依赖运行 profile 中已挂载的官方运行时及其投影。成员运行状态不等于任务完成状态：“未驻留”不是“已完成”，任务状态仍依赖模型更新。监控不向浏览器传输邮箱正文或 provider 错误原文。最多显示 256 个成员 / 1,000 个任务，超限时明确提示，汇总仍包含全部记录。
- 工作流最多显示 100 次运行、合计 256 条成员记录，汇总保持完整。未记录结束的冷历史不会冒充实时运行；原步骤或轮次已关闭时标记中断。监控只读取公开记录，不读取／执行工作流脚本，普通子代理不会被伪装成实验性 Team。
- 原生子会话目录来自公开的 `subagents.listDescendants`，通过非写入的 `sessionPersistence.inspect()` 获取自身标题与轮次结果。实际 Agent 的运行／空闲状态优先，不能用“仍驻留”冒充“正在执行”。历史筛选包含当前未运行的会话，不表示全部成功。目录最多展示 256 条、优先运行中的 Agent；超限时显示已展示／总数，筛选计数只针对已展示条目。目录不可用不会影响已有 Team／工作流记录的查看。

仅安装该 Profile 功能可使用 `-Features agent-team-monitor`，`-ListFeatures` 可列出所有选择；Windows Launcher 必选规则不变。浅色、深色、跟随系统和中英文均随 DSH 设置变化。

## 兼容性与迁移

- **版本对应：** [`dsh-compatibility.json`](dsh-compatibility.json) 统一维护各插件版本支持的 DSH 版本及验证提交。聚合包、6 个独立功能包和 Windows Launcher 均使用 `7.2.3`。
- **V3 消息编辑：** 替换操作改用 `startSeq/endSeq`；新来源格式通过原始消息 ID 保持重编号后的关联。旧编辑日志迁移前应执行上文离线修复。附件气泡使用当前公开的 `FileTypeIcon`，不再引用已移除的 `DocumentFileIcon`。
- **历史监控：** 监控冷读取使用共有的公开 `sessionQuery.observeSession()`，指定 `projectionMode: 'none'`，读取后释放 observation，不激活 Agent、不提交崩溃修复。自定义 profile 的历史监控需要 `sessionQuery` 提供方，标准 Web profile 已包含。Agent Teams v1/v2 历史兼容由当前官方 Team 投影负责；拒绝的历史显示为不兼容，本插件不改写日志。
- **安装前检查：** 安装脚本和 Launcher 更新流程在构建、停止服务或修改 profile 之前，优先获取本仓库 GitHub `master` 分支上的对应关系文件。请求失败、下载超过 8 秒、内容格式错误或过大时，显示警告并回退包内文件；远端有效但没有匹配当前插件及 DSH 版本的记录时也会检查包内文件。只有两处都不支持当前 DSH 版本才拒绝安装。每次检查重新获取，不覆盖本地回退文件。插件包版本混杂也会停止。每个 DSH 版本独立关联提交；commit 未列入该版本记录、源码有本地已跟踪修改或 ZIP 无 Git 信息时显示“未经验证”警告。
- **新版接口：** Client 使用 `client-store`、`ui-session`、`ui-chat` 和公开 Remote；不再依赖已删除的 `dsh-client-runtime`、`connection.api` 或 `hostDescription`。Host 设置 owner 使用经校验的 namespace 字面量和 `SettingsProvider.installSection()`。Session consumer 使用 `eventAt()` / `snapshotEvents()`，并把 `SessionLogOffset` 继承边界与 `SessionHeader` 分开传递；Team Monitor 从 query observation 到 projection 回放都保留这条精确边界。本项目以上述源码 commit 的公开接口为准。
- **提供方来源：** `subagent-codex`、`subagent-claude-code` 的 Loader ID 不变，改由本包的 `sub-agent/codex`、`sub-agent/claude-code` 入口转出官方提供方；独立包对应 `./codex`、`./claude-code`。这样新版 DeepSeek 请求的活动插件清单能解析其包来源，无需关闭该功能或修改 DSH。
- **独立构建：** 各功能发布物携带自身源码和构建脚本，可在没有 sibling DSH checkout 的目录执行 `npm install --legacy-peer-deps`、`npm run prepare` 和 `npm pack`；运行时仍由匹配版本的 DSH 提供公开 peer 服务。Windows Launcher 原生重建需要 Windows 与 .NET Framework 4.x 编译器。
- **架构边界：** Web 功能通过公开 Service、event、slot 和 settings 扩展；Windows Launcher 是独立 Companion，不进入 Cordis 插件树。
- **文件引用已退役：** 最新官方 DSH 已原生支持 [`@` 文件引用](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/context/file-reference)。在输入框键入 `@`，含空格路径可键入 `@"`。旧 `referenced-file` 安装名称和 `#` 快照语法不再提供。
- **模型输入类型已退役：** 官方“设置 → 模型”页面的“模型选项”支持逐模型勾选“文本”和“图片”。`-Features model-input-types` 会被拒绝；正常运行安装脚本会清理历史独立包或替换旧聚合包，不删除用户已有模型能力设置。
- **从 7.2.1 Launcher 迁移：** 若旧 Launcher 的目标集合仍包含 `model-input-types`，其旧版更新协调器无法识别新版功能目录。先获取新版源码，直接运行新版 `migrate-to-enhanced-plugin.ps1` 并传入当前希望保留的功能集合（例如 `-Features all`）；这一步会移除旧包并更新 Launcher，之后可恢复在 Launcher 中更新。
- **自动清理：** `-Features referenced-file` 也会被明确拒绝；正常运行安装脚本会清理历史独立包或旧版聚合包中携带的该功能。

只检查版本对应关系、不构建或安装（非同目录时追加 `-DshCheckout`）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\migrate-to-enhanced-plugin.ps1 -CheckCompatibility
```

需要旧版 DSH 时应选择其对应的插件版本，不要仅删除 peer dependency 检查或强行安装新版插件。

验证新版 DSH 仍兼容后，只需编辑根目录 [`dsh-compatibility.json`](dsh-compatibility.json)：保持 `schemaVersion: 1`，在 `releases` 中找到精确的 `pluginVersion`，向其 `dsh` 数组追加 `{ "version": "<精确 DSH 版本>", "commits": ["<完整的小写 40 位 Git 哈希>"] }`。若只有提交改变，在该 DSH 版本的 `commits` 中追加即可。保留旧插件版本记录，以服务已有安装器。将此文件推送到 GitHub `master` 后，使用新安装器的用户无需更新插件代码即可获取新对应关系；旧安装器需要先升级到这套机制。GitHub 缓存可能造成短暂延迟。

`peerDependencies` 仍是精确的包管理器声明，但由此表自动生成。`npm run build`（或 `npm run sync:compatibility`）按包内表同步各源码 manifest 及根锁文件元数据；安装器在构建后按本次选中的远程／本地表再次同步，`-SkipBuild` 同样适用。这些生成的改动可能出现在本地工作区，但只更新兼容关系时只需提交 JSON 文件，无需手工维护各包的依赖版本；插件版本号、实现和其他依赖字段不变。直接使用 `dsh plugin add` 或 Desktop 导入会绕过本安装器，采用发布物里的 peer 快照，需按更新后的表重新构建／打包后再走该路径。

默认端点为 [GitHub 原始对应关系文件](https://raw.githubusercontent.com/sky-unicorn/dsh-enhanced-plugins/master/dsh-compatibility.json)。可用 `DSH_COMPATIBILITY_URL` 指向 HTTPS 镜像，仅本机回环测试服务器允许 HTTP。文件只能提供数据，不能改变代码、包下载地址或构建命令。`-CheckCompatibility` 保持只读。


## 配置参考

默认组合位于 [`cordis.patch.yml`](cordis.patch.yml)。后应用的 profile patch 会整体替换目标 Loader 行的 `config`，因此覆盖时必须重述该行需要保留的全部字段。

<details>
<summary><strong>桌面提示默认配置</strong></summary>

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `completionSound` | `subtle` | 任务完成提示音：`off`、`subtle`、`prominent` 或上传的 `custom` |
| `confirmationSound` | `prominent` | 需要关注提示音：`off`、`subtle`、`prominent` 或上传的 `custom` |
| `blockedSound` | `prominent` | 任务受阻提示音：`off`、`subtle`、`prominent` 或上传的 `custom` |
| `soundGain` | `0` | 默认音和自定义音共用的 0–100% 正向增益；100 约为 +6 dB |
| `petEnabled` | `false` | 是否显示原生全局桌面宠物 |
| `petCharacter` | `classic` | `classic`（平面小鲸）、`multiview`（立体小鲸）或 `whale-girl`（鲸鱼娘） |
| `petIdleTopmost` | `true` | 空闲状态是否仍保持置顶 |
| `petSize` | `112` | `80`、`112`、`144` 或 `176` 设备无关像素 |
| `petPosition` | `bottom-right` | `top-left`、`top-right`、`bottom-left` 或 `bottom-right` |

六个 `*CustomSoundFile` / `*CustomSoundName` 字段由 Host 管理三类提示音的选择引用。共享目录保存在 profile 内的 `desktop-notifications/sound-library.json`；请通过设置页面上传和选择自定义音，不要手工编辑这些字段。

</details>

<details>
<summary><strong>插件社区 Host 配置</strong></summary>

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `profile` | `web` | 安装和卸载目标 profile |
| `topic` | `dsh-plugin` | 已校验渠道文档必须匹配的 topic |
| `channelUrl` | `market-index` 分支 HTTPS 快照 | “同步最新索引”使用的发布地址 |
| `pageSize` | `12` | 每页插件数 |
| `operationTimeoutMs` | `120000` | 安装和卸载超时 |
| `githubTokenEnv` | `GITHUB_TOKEN` | credentials 引用名 |
| `cliPath` | 空 | 可选 DSH 可执行文件绝对路径 |

内置 [`assets/plugins-cache.json`](assets/plugins-cache.json) 是只读引导快照，也是自动索引首次运行的增量校验种子。缓存、ETag、后台任务和安装记录由 Host 管理并保存到 DSH home。插件社区不会解析 README 中的 shell 命令，也不会启用 `dangerouslyAllowAllBuilds`。

</details>

若只想让部分 Agent preset 获得产品子智能体工具，请禁用或移除根层 `subagent-product-toggle-tools` 行，再只在目标 preset 中挂载对应入口：

- 聚合包：`dsh-enhanced-plugins/sub-agent/preset`
- 独立包：`dsh-enhanced-sub-agent/preset`

同一 scope 不要同时挂载两种布局。

## 开发与验证

本仓库以只读 sibling checkout 作为 DSH API、类型和真实 Web 组装基准：

```text
D:\work\workspace\github\deepseek-harness
```

常规验证命令：

DSH 运行时与 `lib/types` 必须来自同一次源码构建；基于旧声明文件通过 typecheck，不能证明兼容更新后的 checkout。

```powershell
npm install
npm run typecheck
npm test
npm run build
npm run pack:dry-run
git diff --check
```

Windows 上可额外运行 `npm run verify:compat`：在独立临时 DSH home 中逐个安装 6 项功能，检查全量、多功能重选、旧模型包清理和聚合包的真实 Host 启动及 Client 资源；不会修改长期 profile。该命令需要先完成 DSH 与插件构建，验证记录保存在被 Git 忽略的 `.verify-dsh-home/`。页面交互和 light/dark 视觉验证仍需在真实 Web 页面完成。

需要使用隔离构建时，可将 `DSH_VERIFY_CHECKOUT` 设置为已验证 DSH commit 的构建副本路径，再运行 `npm run typecheck`、`npm test` 或 `npm run verify:compat`。默认仍使用 sibling checkout，安装器仍会核对声明的版本。

`npm run verify:desktop-launcher` 用编译后的 Launcher 验证源码命令选择、构建前置条件、重复启动抑制、pnpm 版本失败和进程树清理。`npm run verify:desktop-source` 通过 Launcher 在临时源码视图执行未经修改的官方 `start:desktop` 脚本，等待真实 Electron 页面后停止进程树；不会修改 sibling checkout。

`npm run verify:desktop-host` 在隔离目录中加载官方 Desktop Host 与固定插件发布快照，并验证实际 Client 首页响应；它不构建或修改 DSH checkout。

`npm run verify:launcher` 在临时目录中验证编译后的 Launcher 和 PowerShell 命令引擎，包括清理、安装、构建的顺序、失败即停止，以及真实 pnpm 对过期锁文件的拒绝。需要 Windows，并在 `PATH` 中提供 Git 和 pnpm；不会清理或重建真实 DSH checkout。

`npm run verify:launcher-tools` 将 Launcher 与 MCP 管理包安装到临时目录，通过真实 Launcher 启停 DSH，再由本地测试模型调用官方 `read` 工具并核对文件内容。它覆盖系统模式和本机有 NVM 时的沙盒模式，无需真实模型或 MCP 密钥。可将 `DSH_VERIFY_MANAGER_ROOT` 指向已有 pnpm package 目录，复制到临时缓存后由运行时校验版本，避免验证被首次下载耗时影响。

`npm run verify:launcher-ui` 在隔离目录中编译并验证真实 WinForms 控件：滚动、筛选、批量选择、页面与模式切换、重复布局、UTF-8 日志读取上限及已移除控件的释放。它使用约 64 MB 的日志测量切页耗时，并检查五个页面在普通、紧凑、宽屏与 150% 缩放下的布局；截图保存在 `.verify-dsh-home/ui-performance/`。输出的耗时是界面处理与离屏绘制基准，不代表显示器实际帧率，也不使用易受机器负载影响的固定耗时阈值判定通过。

`npm run test:launcher-toolchain` 验证版本检测、NVM 回退、声明冲突和环境隔离（先构建 Launcher）。`node scripts/verify-launcher-sandbox.mjs <DSH-checkout>` 在 Windows 上使用临时 DSH Home 验证真实 Web 就绪、所选包管理器、缓存重启和停止，可能下载所需包管理器；只读引用 DSH checkout，截图与结果写入 `.verify-dsh-home/sandbox-artifacts`。

`npm run verify:pack` 会将独立包打成 tarball，在没有 DSH peer 包的隔离目录重新安装构建依赖、执行 `prepare` 并检查再次打包的入口；Windows Companion 的这项验证也需要 Windows。

浏览器 bundle 使用 CSS Modules，并且只消费 DSH 的 `--dsw-alias-*` 语义主题 token，会自动跟随 light、dark 与 system 外观。插件架构与公开扩展点可参考 [DSH 插件开发文档](https://deepseek-harness.github.io/deepseek-harness/develop/basic/) 和 [架构参考](https://deepseek-harness.github.io/deepseek-harness/reference/)。

`npm run verify:edit-web` 在隔离 profile 安装编辑插件，使用本地 SSE 模型 fixture 驱动真实 Chromium/Web 组合，验证连续编辑、模型历史替换、文件与 Skill 引用预览、刷新恢复和 light/dark 截图，不需要真实模型密钥。默认验证 DSH 的 Messages 协议；设置 `DSH_VERIFY_PROTOCOL=chat-completions` 可额外验证显式选择该协议的情况。测试关闭会话日志上传，Launcher 文件也只安装到测试临时目录。它使用 DSH 构建副本中的 Playwright，需已安装对应 Chromium。`typecheck` 会拒绝 Session 声明版本不匹配、缺少 `openSkill`，或没有新版插件配置与会话引用接口的陈旧构建。Web、Desktop 验证命令均支持 `DSH_VERIFY_CHECKOUT` 指向隔离构建。


`npm run verify:plugin-ui` 在真实 Web profile 验证 MCP 保存与草稿丢弃、插件热启停，以及真实 Team 的监控与成员跳转，并检查 light/dark 配色。设置 `DSH_VERIFY_AGGREGATE=1` 验证聚合包；默认验证两个相关独立包的组合。发布前可将 `DSH_COMPATIBILITY_URL` 指向隔离测试服务，使验证使用待发布的兼容表；远端没有匹配记录时改用包内表。

DSH `0.1.6-alpha.2` 的实际配置入口是 `plugins.row.config`／`plugins.bundle.config`；在线设置卡片 cookbook 仍可能展示旧 `settings.plugin.item`，本版本以已验证提交的源码和类型为准。

## License

[MIT](LICENSE)
