# dsh-enhanced-plugins

[English](README.md) | 中文

`dsh-enhanced-plugins` 是面向 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) Web profile 的一体化增强插件包。安装一次即可获得原生桌面提示与 DeepSeek 宠物、插件社区、MCP 服务器管理、模型请求类型、工作区文件引用、上一条消息重发，以及 Claude Code / Codex 子智能体开关。

本项目只使用 DSH 的公开插件扩展点，不修改 DSH 核心。七项功能分别维护自己的 Host、Client、Settings 和运行时生命周期，因此某个可选依赖不可用时不会阻止其他功能加载。

## 功能一览

| 功能 | 使用位置 | 用途 |
| --- | --- | --- |
| [桌面提示与宠物](#桌面提示与宠物) | 设置 → 桌面宠物 | 播放默认或自定义任务提示音，并可显示原生动态 DeepSeek 鱼宠物 |
| [插件社区](#插件社区) | 设置 → 插件社区 | 搜索、安装和卸载社区 DSH 插件 |
| [MCP 服务器管理](#mcp-服务器管理) | 设置 → 插件 → 插件配置 → MCP 服务器 | 管理 stdio / Streamable HTTP MCP 服务器 |
| [pi-ai 模型请求类型](#pi-ai-模型请求类型) | 设置 → 插件 → 插件配置 → pi-ai 模型请求类型 | 声明模型接受纯文本还是图片请求 |
| [工作区文件引用](#工作区文件引用) | 会话输入框中输入 `#` | 搜索文件并把文本快照加入下一次请求 |
| [编辑上一条消息](#编辑上一条消息) | 最后一条用户消息气泡 | 修改该轮内容并在当前会话重新生成 |
| [产品子智能体](#产品子智能体) | 设置 → 子智能体 | 实时启用或停用 Claude Code / Codex 工具 |

## 运行要求

- Node.js 22.19 或更高版本。
- DSH Web profile；本仓库当前针对 DSH `0.1.0-rc.5` 的公开 ABI 验证，本地基准 commit 为 `47f943859bef60e4160492346772ded9b24f765a`。
- 原生提示音与桌面宠物功能需要 Windows 10 或更高版本及 Windows PowerShell 5.1；包内其他功能仍可跨平台使用。
- DSH 官方包由 Harness 提供，本插件不会复制或 patch DSH 核心。

DSH 仍处于开发者预览阶段。升级 DSH 后若出现接口不兼容，请先核对本项目支持的 ABI 再升级插件。

## 安装

安装脚本会自动完成依赖安装、插件构建、`web` profile 安装和加载验证。以下命令都需要在 `dsh-enhanced-plugins` 仓库根目录执行。

### 插件与 DSH 源码位于同一父目录

目录结构如下：

```text
<工作目录>/
├── deepseek-harness/
└── dsh-enhanced-plugins/
```

脚本会自动找到同级的 `deepseek-harness`：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\migrate-to-enhanced-plugin.ps1
```

### 插件与 DSH 源码位于不同目录

通过 `-DshCheckout` 指定 DSH 源码目录：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\migrate-to-enhanced-plugin.ps1 -DshCheckout "E:\projects\deepseek-harness"
```

脚本执行成功后，如果 DSH 已在运行，重启一次即可使用。

## 使用说明

### 桌面提示与宠物

位置：**设置 → 桌面宠物**。它现在是设置左侧导航中的独立入口，不再放在“插件配置”卡片中。

1. 为任务完成和需要确认两类事件分别选择**关闭**、两档内置默认音或**自定义 WAV**。上传 WAV 后会立即选中；文件不得超过 2 MiB，并保存在当前 DSH profile 中。
2. 打开**启用桌面宠物**，即可在浏览器之外显示原生 DeepSeek 鱼图标。**空闲时保持置顶**默认开启；关闭后空闲宠物可被其他窗口遮挡，任务中、需要确认和结束反馈仍会置顶。
3. 选择宠物大小和启动位置；显示后可以在桌面上自由拖动。宠物不能越过物理桌面的外边缘，但相邻显示器之间的边界保持开放，可以直接拖到另一块屏幕。松开鼠标时窗口会完整落在目标显示器的可见工作区内，插件同时在当前 profile 内按显示器记录归一化位置；大小和位置在修改其他设置或重启后都会恢复。分辨率、缩放或工作区发生变化时会重新换算并限制在可见区域；原显示器离线时回退到另一台保存过的在线显示器或配置角落，重新连接后仍能恢复原显示器位置。修改“启动位置”会清除这些拖动记录并重新使用所选角落。

宠物采用独立实现的 Hatch 风格动态表现，但不复制 Codex 的私有素材或实现：启用时先孵化登场，**空闲**时缓慢漂浮、呼吸并随机做待机动作，**任务中**会游动、吐泡泡并旋转进度环，**需要确认**时会跳动、摇晃、脉冲并显示感叹号；顶层任务结束后还会短暂显示**已完成**庆祝或**任务受阻**反馈。状态会汇总所有会话，“需要确认”拥有最高优先级。完成提示音和结束反馈只针对顶层任务，子智能体结束不会造成重复提示。

设置实时生效。动画由 WPF 原生动画系统执行，窗口保持响应；鼠标悬浮会触发轻微互动并保持箭头光标，拖动期间才显示移动光标。Windows 开启“减弱动画”后，宠物自动使用静态状态帧。关闭宠物时，插件会协作式关闭并等待其 PowerShell/WPF 进程退出；宠物关闭但提示音开启时，仅为一次提示启动短生命周期进程，不留下常驻 helper。子进程只接收固定脚本路径与 stdin JSON 控制消息，并由 DSH subprocess service 负责进程树清理。

### 插件社区

位置：**设置 → 插件社区**。

1. 首次打开会读取内置插件快照；需要刷新社区数据时点击“同步渠道”。
2. 在搜索框按仓库名、包名、描述或 topic 查找插件。
3. 安装前打开 GitHub 仓库核对来源；点击“安装”后等待操作完成。
4. 在“已安装”标签页查看或卸载由插件社区安装的项目。
5. 安装或卸载完成后，按页面提示重启当前 Web profile。

未配置 GitHub Token 也能使用内置快照。若同步触发 GitHub API 限流，可点击“配置”，保存只读、短有效期的 Fine-grained Token；Token 只发送到本机 DSH Host，并保存在 credentials 服务中。

![插件社区页面](assets/readme/plugin-community.png)

### MCP 服务器管理

位置：**设置 → 插件 → 插件配置 → MCP 服务器**。

1. 点击“添加服务器”，填写唯一名称并选择传输类型。
2. `stdio` 服务器填写命令、参数、工作目录和环境变量；Streamable HTTP 服务器填写 HTTP(S) URL 与请求头。
3. 也可以点击“一键导入 Claude Code 与 Codex”，由 Host 读取本机已有配置。名称或内容重复的项目会跳过，无法安全转换的项目会给出原因。
4. 检查卡片顶部的格式审计结果，然后点击“保存”。保存成功后 Host 会按服务器分别启动、更新或卸载连接。

浏览器重新读取已有服务器时，环境变量和请求头的值会被掩码；未修改的机密不会从脱敏快照重建或覆盖。

![MCP 服务器管理](assets/readme/mcp-server-manager.png)

### pi-ai 模型请求类型

位置：**设置 → 插件 → 插件配置 → pi-ai 模型请求类型**。

1. 先在 DSH 的“模型”页面或 `settings.yaml` 中添加 pi-ai 模型覆盖。
2. 展开“pi-ai 模型请求类型”卡片。
3. 为每个模型选择“提供方默认”“仅文本”或“文本与图片”；选择会立即保存。

只有官方 `llm-pi-ai` settings namespace 可用时才显示此卡片。这里保存的是能力声明，不会探测实际端点；把模型声明为“文本与图片”之前，请确认提供方确实接受图片请求。

![pi-ai 模型请求类型](assets/readme/model-input-types.png)

### 工作区文件引用

位置：**任意已选择工作区的会话输入框**。

1. 输入 `#`，并继续输入文件名或路径片段缩小候选范围。
2. 使用 `↑` / `↓` 选择文件，按 `Enter` 插入引用；也可以直接点击候选。
3. 继续编写问题并发送。Host 会在提交时重新解析路径、检查工作区边界，并把文件的 UTF-8 文本快照加入本次模型请求。

默认最多引用 8 个文件，单文件 128 KiB、总计 512 KiB。二进制文件、非法 UTF-8、超限文件、非常规文件和工作区外路径会被拒绝。

![在输入框中引用工作区文件](assets/readme/referenced-files.png)

### 编辑上一条消息

位置：**当前会话最后一条可编辑的用户消息气泡，位于“复制”旁边**。

1. 等待当前会话结束，或先手动停止正在运行的会话。
2. 点击“编辑上一条消息”，在气泡内修改文本。
3. 点击“重新发送”，或按 `Ctrl/⌘ + Enter`；按 `Esc` 或“取消”可退出编辑。

重新发送仍在当前会话内完成。插件会从被编辑的用户消息开始替换当前模型上下文，再通过同一个 AgentLoop 生成后续内容。DSH 的原始 Session 日志保持追加式审计记录；已经执行的工具产生的外部副作用不会回滚。为避免静默丢失内容，包含图片或其他非文本块的消息不提供编辑入口。

![编辑上一条消息并重新发送](assets/readme/edit-last-message.png)

### 产品子智能体

位置：**设置 → 子智能体**。

1. 打开 Claude Code 或 Codex 开关。
2. 变更会立即应用到加载了本控制插件的 Agent preset，包括正在运行的会话，无需重启 profile。
3. 关闭开关会实时移除对应工具；本机对应产品及其官方 DSH provider 仍需可用。

两个开关默认均为关闭。开关只按路径写入对应布尔值，并使用设置修订号防止覆盖其他页面或外部编辑产生的新值。

![Claude Code 与 Codex 子智能体开关](assets/readme/subagent-toggles.png)

## 高级配置

插件的默认组合位于 [`cordis.patch.yml`](cordis.patch.yml)。后应用的 profile patch 会整体替换目标 Loader 行的 `config`，覆盖时请重述该行需要保留的全部字段。

<details>
<summary>桌面提示默认配置</summary>

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `completionSound` | `subtle` | 任务完成提示音：`off`、`subtle`、`prominent` 或上传的 `custom` |
| `confirmationSound` | `prominent` | 需要关注提示音：`off`、`subtle`、`prominent` 或上传的 `custom` |
| `petEnabled` | `false` | 是否显示原生全局桌面宠物 |
| `petIdleTopmost` | `true` | 空闲状态是否仍保持窗口置顶 |
| `petSize` | `112` | 宠物尺寸：`80`、`112`、`144` 或 `176` 设备无关像素 |
| `petPosition` | `bottom-right` | 回退/重置角落：`top-left`、`top-right`、`bottom-left` 或 `bottom-right` |

四个 `*CustomSoundFile` / `*CustomSoundName` 字段由 Host 管理上传元数据，请通过设置页面选择自定义提示音，不要手工编辑这些字段。

</details>

<details>
<summary>插件社区 Host 配置</summary>

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `profile` | `web` | 安装和卸载的目标 profile |
| `topic` | `dsh-plugin` | GitHub 发现 topic |
| `pageSize` | `12` | 每页插件数 |
| `operationTimeoutMs` | `120000` | 安装和卸载超时 |
| `githubTokenEnv` | `GITHUB_TOKEN` | credentials 引用名 |
| `cliPath` | 空 | 可选 DSH 可执行文件绝对路径 |

内置 [`assets/plugins-cache.json`](assets/plugins-cache.json) 是只读快照；同步缓存和安装记录保存在 DSH home 的插件市场数据目录。

</details>

<details>
<summary>工作区文件引用默认限制</summary>

| 字段 | 默认值 |
| --- | ---: |
| `maxCandidates` | 20 |
| `maxScannedEntries` | 5000 |
| `maxDepth` | 12 |
| `maxReferences` | 8 |
| `maxFileBytes` | 131072 |
| `maxTotalBytes` | 524288 |
| `indexTtlMs` | 30000 |
| `maxCachedWorkspaces` | 8 |

</details>

若只想让部分 Agent preset 获得产品子智能体工具，请禁用或移除根层的 `subagent-product-toggle-tools` 行，并只在目标 preset 中挂载 `dsh-enhanced-plugins/sub-agent/preset`。同一 scope 不要同时挂载两种布局。

## 开发与验证

仓库规则使用以下只读 sibling checkout 作为 DSH API、类型和真实 Web 组装基准：

```text
D:\work\workspace\github\deepseek-harness
```

常规验证命令：

```powershell
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
git diff --check
```

浏览器 bundle 使用 CSS Modules，并且只消费 DSH 的 `--dsw-alias-*` 语义主题 token，因此自动跟随浅色、深色和系统外观。

## License

[MIT](LICENSE)
