# Official Agent Teams monitor / 官方团队监控

Read-only Host adapter and Web panel for DSH `0.1.2-alpha.3` (ABI `dd6322d6`).
The session-owned icon appears in the composer's model/context group when workflow, Agent Teams or native child-session records exist. Click to open; switching sessions closes and clears it.
Standard workflow monitoring needs no experimental Team runtime. Agent Teams itself must be enabled separately in the DSH source profile.
This bundle never enables it, creates agents, adds model tools, changes tasks, or schedules work.

只读 Host 适配器与 Web 面板。当前对话存在工作流、Agent Teams 或原生子代理会话时，在输入框右侧模型／上下文同组显示团队图标；点击才展开，切换会话立即关闭并清空。
标准工作流无需实验性 Team 运行时；Agent Teams 请单独在 DSH 源码 profile 中启用。本插件不会自动启用、组队或调度。

Live members come from `ctx.agentTeams`; historical roster/tasks/mailbox counts are replayed through public `ctx.sessionProjections.restore()` using the `agentTeam` projection owned and registered by the official runtime.
No private source imports or workspace-local state files. Mail bodies and provider errors are not sent to the browser.
Workflow members/phases/outcomes come from the current session's own public `tool-workflow/*` events, separate from the experimental task board. Only actual starts count; script plans, dependencies and mailboxes are never invented. Cold unfinished work is not reported as live or completed.
An unavailable storage or unsupported log is shown explicitly once activity has been detected. An inactive member is not a completed task.
The view is bounded to 256 members and 1,000 tasks; totals remain complete.

Role groups retain distinct native child-session IDs, including nested descendants and multiple executions with the same creation label. All / Running / History filters link to DSH's native session details through a freshly validated parent/child address. Missing role labels are not inferred. Native catalog reads are capped at 256 sessions with explicit truncation; filter counts apply to displayed rows. Cold sessions are inspected without activation; inactive/idle is not a successful completion.
角色分组保留每个独立子会话 ID，包含嵌套子会话和同名角色的多次执行。支持全部／正在执行／历史会话筛选，并通过重新核对的父子地址进入 DSH 原生详情。缺失标签不猜测角色；目录最多展示 256 条并提示截断，筛选计数对应已展示条目。冷会话只读检查、不唤醒；空闲／未驻留不代表完成。

实时成员来自官方服务，历史通过官方运行时拥有的 `agentTeam` 投影和公开 `ctx.sessionProjections.restore()` 从 Session 日志回放。
不读取私有源码，不建立额外团队持久化文件，不向浏览器发送邮箱正文或 provider 错误原文。
任务状态依赖模型更新；“未驻留”不等于“已完成”。
工作流从当前会话自己的公开事件读取成员、阶段和结果，与实验性任务板分开展示；不把计划中的角色算成队员，不推测依赖或邮箱。冷历史未结束的运行不会冒充实时或完成。
工作流最多显示 100 次运行与合计 256 条成员记录，汇总完整；仅轮询当前会话（展开 1.5 秒／收起 5 秒），隐藏页面或断线暂停。

The build uses shared repository source when present; packaged source under `src/` supports isolated `npm run prepare` with the package's esbuild development dependency.
发布包含可独立构建的源码与构建脚本，不需要 sibling DSH checkout 才能 prepare。
