# Model collaboration V3 / 多模型协作

DSH `0.1.6-alpha.2`, verified against checkout `ddefc45fbc7f8e46dd73185e68295696d1297887`. Install identity: `model-router`; independent bundle: `dsh-enhanced-model-router`. The aggregate also includes this feature.

## 安装与使用

在增强插件仓库执行（省略 `-Features` 为全量安装；`-ListFeatures` 列出可选功能）：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\migrate-to-enhanced-plugin.ps1 -Features model-router
```

1. 先在 DSH 模型设置中配置可用模型和凭据。插件仅保存精确的供应商路由与模型 ID，不保存密钥。
2. 打开“设置 → 多模型协作”，从已配置模型目录选择轻量、普通、强力三个模型。移除备用模型选择；任意一档未配置，设置与会话入口均不能开启，Host 同步拒绝。全局功能默认关闭，三个模型可以相同。
3. 主助手使用普通档，按需要派发搜索（轻量，只读）、执行（普通，可修改）和专家（强力，只读）。简单问题可以直接回答，不额外调用分类模型。
4. 会话输入区“多模型协作”菜单打开右侧详情；详情采用单页信息流展示任务摘要、实际模型调用和任务时间线，请求明细与会话历史按需展开，路由与任务控制保持折叠。
5. 同一目标的后续补充与“继续原任务”保留计数；新业务目标使用“开始新目标”，然后发送需求。计数仅用于观察，不再作为累计停止条件。

模式在下一次请求边界生效，不重启正在流式输出的请求。暂停等待在途操作收敛；停止传递取消并等待子任务清理。刷新只读已有记录，Host 重启后未完成执行显示“已中断”，继续前须核对已有操作。设置变更影响新目标，已有目标保留策略快照；会话固定模型优先于快照。

受管工具范围保持有限：搜索／专家仅有已注册的 `read`、`read_image`、`glob`、`grep`；执行额外拥有 `edit`、`write`、`bash`。程序化调用仍通过相同工具守卫与写锁。子助手不能再委派；原 DSH 审批和沙箱仍生效。执行结果是模型报告，主助手仍须验收。

受管执行不允许 `bash` 的 `run_in_background`，以便停止和卸载时等待在途操作完成清理。

默认控制：最多 2 个子任务同时运行、单次失败额外重试最多 2、增加深度 1、单根任务记录 2 MiB。请求和子执行总次数不限，不再需要追加次数。底层 adapter 自行进行的不可观测 HTTP 重试不计为额外可观测请求。V3 提供基于证据的升级和可选规划切换，同时记录实际用量和请求次数。累计 token 限额与模型报价已移除。

## 自动切换（V2 起）

主助手通过 `model_router_review_task` 提交语义验收，Host 根据自己记录的工具证据确认归属、顺序和去重。验收项使用 `A1`、`A2` 等稳定 ID。默认同一有效模型、同一验收项两次不同修复失败才升到下一有效档位；初始失败不计数。重复补丁、重跑测试、失败的工具派发及非能力问题均不会被当作有效修复。专家咨询记录为 `complexity_direct`。

升级保留 taskId、创建新 executionId，继承原目标、约束、已有操作结果、证据与待解问题；请求与子执行保留原任务记录。固定模式禁止自动换模。设置 → 自动切换规则可调整阈值和最多两次升级。临时网络/服务故障仅在同一角色模型上按单次重试上限重试，不因故障切到备用模型；旧配置及旧任务快照中的备用引用不再参与路由。

规划切换默认关闭，需要当前会话的公开规划服务或 plan projection 与退出工具；尚无可用会话能力时控件禁用。开启后主助手规划用强力档，DSH 批准或用户明确退出规划后用普通档；受管写操作在规划状态下被拒绝。插件不提交批准，也不从模型文字猜测批准。

工作区核验只接受明确的文件／目录范围，最多 2,000 个条目、16 MiB 文件内容；跳过 `.git`、`node_modules`，拒绝通配符、符号链接、越界及特殊文件。范围不可核验、文件变化或存在失败写操作时停止自动交接，要求重新检查。指纹是交接时的检查点，不是文件系统事务锁或对外部副作用的证明。

首次启动按 V4、V3、V2、V1 顺序只读导入独立 V5 domain，保留原件；不会把新记录写回旧格式。旧任务保留旧策略，不追溯补写工作类型，需新目标使用当前检查点。回退旧插件只能看见升级前历史，不能继续 V5 记录。

## Installation and use

Select `model-router` with the existing installer, or omit feature selection for the complete suite. Choose all three role models from the configured catalog under Settings → Model collaboration, then enable it. If any role is unconfigured, both Settings and session activation remain disabled, with Host validation as well. Backups are no longer configurable or used. Configure credentials through DSH's own Models settings.

The normal model coordinates the conversation. Search uses the light model; execution uses normal; experts use strong. Search and experts are read-only. Fixed mode overrides all managed roles without expanding permissions. The composer panel exposes task results, actual request identities, counters, pause, continue and stop.

Before the main assistant can mutate files or run code, the Host requires a `model_router_task` decision with a work type. Answers and known small changes may stay direct; research requires a Light search child, implementation requires a Normal execution child, and diagnosis or analysis requires a Strong expert child. Read-only discovery may happen before the decision, but a prompt alone cannot bypass this Host checkpoint.

Followups and Continue retain the original ledger. Choose Start new objective before sending an unrelated objective. Refresh does not replay work; interrupted runs require explicit continuation and verification of previous side effects. Global defaults apply to new objectives. A request already in progress is never restarted by a mode change.

Observable request and child-execution counters do not stop a task, regardless of their totals. Concurrency, per-request retries, nesting depth and record-capacity protection remain. Adapter-internal HTTP retries can be opaque. V3 adds evidence-based escalation and optional plan-mode routing. Reported usage and request counts remain; cumulative token limits and pricing have been removed. Oversized inline child output is replaced with an explicit reference to the durable child session, never silently represented as a complete result.

Managed execution rejects `bash` with `run_in_background` so stop and plugin disposal can drain owned work.

## Routing and compatibility (since V2)

The main assistant submits semantic acceptance through `model_router_review_task`; Host verifies task-owned evidence, chronological ordering and duplicate fingerprints. Two distinct failed repairs for the same acceptance (`A1`, `A2`, etc.) and effective model trigger the next distinct tier. Initial failures and repeated tests do not count. Upgrades retain task identity, constraints and completed work while creating a new execution. Fixed mode wins at the next request boundary.

Transient service failures retry the same role model under the existing per-request retry limit. Legacy backup references in settings and task snapshots are ignored. Failures never select a backup provider. Optional phase routing requires a public planning owner, read through its service or the plan projection plus scoped exit tool. It follows DSH approval or explicit user mode changes and blocks managed writes during planning.

Handoff checks explicit workspace files/directories, bounded to 2,000 entries and 16 MiB, excluding `.git` and `node_modules`. Wildcards, symlinks, out-of-workspace paths and special files cannot authorize automatic handoff. Changed/unverifiable state or uncertain failed writes require inspection. Fingerprints are checkpoints, not filesystem transactions or proof about external side effects.

V4, V3, V2 and V1 records are imported in that order, read-only, into the separate V5 domain. Old runs retain their old policy and are not backfilled with a work type. Downgrading shows only the preserved pre-upgrade history and cannot resume V5 records. Record detail displays actual requests, execution chains, review categories, evidence references and complete handoffs.

## Configuration and ownership

Host namespace: `enhanced-model-router`. Current storage domain: `enhanced_model_router_v5` (format 5), tables `session_controls` and `runs`. Settings save automatically using standard revision-fenced path mutations. Runtime records use DSH storage domains and remain after plugin removal. No credentials or raw streaming chunks are copied into them.

```yaml
enabled: false
models:
  light: { provider: '', model: '' }
  normal: { provider: '', model: '' }
  strong: { provider: '', model: '' }
limits:
  maxConcurrentChildren: 2
  maxAdditionalDepth: 1
routing:
  autoUpgrade: true
  repairFailuresBeforeUpgrade: 2
  maxEscalations: 2
  phaseSwitch: false
retry: { maxRetries: 2 }
storage: { maxRunRecordBytes: 2097152 }
```

Host owner: `modelRouter`; model tools: `model_router_delegate_task`, `model_router_review_task`, `model_router_task`; human-control Remote: `modelRouterControl`. The independent bundle has a self-contained `prepare` and lazy-CJS Web module. It does not load the aggregate package or other enhancement features.

## Development

From the repository, use `npm run test:model-router`, `npm run typecheck`, `npm run build`, `npm run pack:dry-run`, `npm run verify:pack`, and `npm run verify:model-router-web`. The Web verifier creates disposable profiles under `.verify-dsh-home`, runs the real sibling Web stack with a keyless fixture adapter, and never calls a paid provider or modifies the sibling checkout.

## 运行记录与评估 / Records and evaluation

协作聚焦三档职责、证据升级和阶段路由。累计 token 限额、报价编辑、价格快照、金额估算及 token 追加已移除；即使旧设置开启限额，也不会再拒绝大窗口或未上报窗口的模型。旧任务因 token 限额暂停后可明确继续，不会自动重放。

Collaboration focuses on role routing, evidence-based escalation and phase routing. Token limits, price editing, price snapshots, cost estimates and token allowances have been removed. Legacy token settings cannot block calls, including models without context metadata. Previously blocked runs can be continued explicitly; no work is replayed automatically.

主助手、子任务、升级、重试及带会话归属的压缩仍记录实际模型和供应商上报用量；未知用量不当作零。并发、失败重试和记录容量保护保持有效。取消请求/子执行总次数限制与追加次数功能，计数仍保留；旧任务因累计次数暂停后可直接继续。

Actual models and reported usage remain available for main, child, upgrade, retry and attributed compaction calls. Unknown usage is not represented as zero. Concurrency, bounded failure retries and record-capacity protection remain. Cumulative request/child limits and allowance controls have been removed. Old capped runs can be continued explicitly with their counters intact.

`routing.fallbacks`、`limits.maxRequests`、`limits.maxChildExecutions`、`budget`、`prices` 和历史请求的预留/报价字段仅为读取旧设置与记录保留。新根任务清空备用引用、不启用限额、不携带报价，新请求不写预留或价格；历史原件不清除。新验收记录存入 `enhanced_model_router_v5`（format 5），只读导入 V4/V3/V2/V1，保留旧原件。

Legacy fallback, cumulative limit, budget, price, allowance and reservation fields remain readable for compatibility. New run snapshots store zero for both retired count caps; old positive caps are ignored. New runs clear backup references, disable token limits and contain no prices; new attempts record neither reservations nor quotes. Existing records are preserved, using the isolated V5 storage format with read-only V4/V3/V2/V1 imports.

离线评估：`npm run evaluate:model-router -- samples.json report.json`。相同输入和环境下比较普通固定、强力固定、自动协作三组的通过率、耗时、用量、派发和升级情况，不再输出金额。确定性 fixture 只验证集成。

Offline evaluation compares matched normal, strong and automatic groups by pass rate, duration, reported usage, delegation and escalation, without cost estimates. Deterministic fixtures verify integration only.

## UI update / 界面改版

三档模型使用可搜索目录；目录部分失败不清空已选模型。缺少供应商或模型 ID（含空白）即视为未配置，开关禁用并列出缺失档位；配齐后才允许开启。关闭状态下可自动保存部分配置；已开启时 Host 拒绝清空任何一档。高级配置折叠，设置提交保留 revision fence；冲突保留草稿，显式放弃草稿才重新读取最新值。协作详情使用 DSH 右侧标签页，隐藏或关闭时释放轮询。

The three role selectors share a searchable catalog. Partial catalog failures preserve existing references. A blank provider or model ID keeps activation disabled, with missing roles listed. Partial configuration can save while disabled; the Host rejects clearing a role while enabled. Settings writes preserve revision fencing and retain drafts on conflicts. Right-sidebar details release polling when hidden or closed.

设置中的全局开关关闭时，不展示输入区“多模型协作”入口；保存开启后直接出现，无需刷新。关闭时清理打开的菜单、请求与轮询，并释放原生单模型选择锁定；保留原有会话模式与任务记录，再次开启后恢复其呈现。

The composer entry is hidden while the global setting is off and appears after enabling is saved, without reloading. Disabling removes open menus, aborts owned requests, stops polling and releases the native single-model selector. Existing session mode and task records are preserved for re-enabling.

**会话控制 / Session controls:** 输入区按钮与 DSH 原生模型/权限控件外观一致。 Composer triggers match DSH’s native model/permission controls. 新会话默认关闭协作。协作管理与单模型选择分开；开启后选模按钮禁用并显示“多模型协作中”，普通选模和推理修改由 Host 拒绝；关闭时恢复原会话选择，不修改全局默认。没有可靠原选择的旧任务可显式选择恢复模型。导航图标和选择控制由可撤销兼容层提供，不修改 DSH 本体。New sessions opt in; the separate model selector is disabled and reads “Model collaboration active” while managed, backed by the Host selection guard. Turning off restores the original session selection without changing defaults. Legacy runs can explicitly choose a recovery model. Compatibility adapters unload cleanly and never edit DSH core files.

**兼容边界 / Compatibility:** 设置跳转继续显示路径；原供应商被移除时，可先选择恢复模型再重新开启。配置修订协议未新增。Settings navigation uses path instructions; if the original provider disappears, choose a recovery model before re-enabling collaboration. Run-policy amendments remain outside this UI change.


## 分工与验收闭环 / Coordination and acceptance

启用会话协作后，公开 `systemPrompt` 扩展点向主助手追加分工指引，向托管子助手追加职责指引，不替换部署或用户规则。简单任务可直接处理；需要定位时用轻量搜索，清晰实现用普通执行，复杂分析或独立审查用强力专家。每次分工写明具体依据，不强制凑齐三个模型。关闭或卸载后撤销这些指引及管理工具。

The public `systemPrompt` extension adds scoped main/child instructions while preserving deployment and user rules. Simple work may remain direct; unknown locations call for Light search, bounded implementation for Normal execution, and difficult analysis or independent review for Strong experts. Decisions include task-specific reasons; using every model is not a success criterion. Off/dispose removes the instructions and tools.

`model_router_task` 提供 decision、inspect、report。inspect 每页最多 32 条列表项，通过 nextOffset 继续读取；可按 executionId 回查旧结果和修复证据。子助手仅能报告自身，主助手负责复核每个原始验收项并提交根任务报告。验收状态区分通过、失败、未验证；子报告等待主助手复核。Host 检查证据归属、真实工具结果、当前执行和任务事实，工具成功本身不能证明业务结论正确，语义验收仍由主助手负责。

`model_router_task` records decisions, inspects owned evidence and reports acceptance. Inspect pages contain at most 32 list entries and return `nextOffset`; historical executions remain inspectable. Children report only their own task. Main review covers every original child acceptance condition before a successful root report is admitted. Host verifies ownership, real tool results, current execution and unchanged task facts; semantic correctness remains the main assistant's responsibility.

界面将“执行已结束”与“验收通过”分开，缺少报告不会补造成功。只读结果对比明确范围的文件指纹，执行期间或结束后变更都会提示重新核查。交接保留目标、约束和全部验收条件，把重复执行历史改为可回查引用；可显式提供 contextSummary 整理背景，超大必要内容仍会拒绝启动并要求缩小范围。

Execution ending is displayed independently from acceptance; missing reports remain unverified. Read-only results check scoped file fingerprints for changes during or after execution. Handoffs retain objectives, constraints and every acceptance condition while replacing repeated execution history with retrievable references. Optional `contextSummary` condenses background; oversized essential content still fails before child startup.

机制回归与真实 DSH Web 验证使用无密钥适配器，不能证明真实模型一定合理分工或节省用量。真实供应商任务对比仍待验收。Keyless integration and Web tests do not establish real-provider delegation quality or usage savings; live comparative evaluation remains pending.

自定义 `complete: true` 系统提示具有 DSH 明确的独占权，追加 section 会被 DSH 抑制；这类预设应自行包含分工规则或允许可组合提示。Custom `complete: true` presets suppress additional system sections by design; they must provide coordination rules themselves or permit composable sections. The plugin does not override that ownership.

Web 验证可设置 `DSH_VERIFY_AGGREGATE=1` 验证聚合包，同样只使用临时 profile。Set `DSH_VERIFY_AGGREGATE=1` to exercise the aggregate package with the same isolated Web verifier.
