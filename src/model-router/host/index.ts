import { taskActionSchema } from './workflow.js'
import { installSelectionBridge } from './selection-bridge.js'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { reviewSchema, runQuerySchema } from '../schema.js'
import ModelRouter from './service.js'
import { snapshotRouterConfig } from './config.js'
declare module '@deepseek-ai/cordis' {
  interface Events { 'loader/volatile-update'(paths: readonly (readonly string[])[]): void }
}
import { DELEGATE_TOOL, REVIEW_TOOL, TASK_TOOL, NAMESPACE, type RouterConfig } from '../shared.js'
export { Config } from './config.js'
export const name = 'model-router'
export const inject = ['agents', 'llm', 'subagents', 'tools', 'storageDomain', 'settings', 'systemPrompt']
const id = z.string().min(1).max(512)
const commandSchema = z.object({ sessionId: id, expectedRevision: z.number().int().nonnegative(), operationId: id,
  action: z.enum(['mode', 'pause', 'continue', 'cancel', 'new', 'allowance']),
  expectedRunRevision: z.number().int().nonnegative().optional(), addRequests: z.number().int().min(0).max(1000).optional(), addTokens: z.number().int().min(0).max(10000000).optional(), mode: z.enum(['auto', 'fixed', 'off']).optional(),
  restoreModel: z.object({ provider: id, model: id, reasoningEffort: id.optional() }).strict().optional(),
  fixedModel: z.object({ provider: id, model: id }).strict().optional() }).strict()
const inputSchema = z.object({ role: z.enum(['search', 'execute', 'expert']), title: z.string().min(1).max(160), objective: z.string().min(1).max(4000),
  reason: z.string().trim().min(1).max(2000).optional(), scope: z.array(z.string().max(1000)).max(32), acceptance: z.array(z.string().max(2000)).min(1).max(20), constraints: z.array(z.string().max(2000)).max(32), context: z.string().max(16000) }).strict()

export class RouterRemote extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'modelRouterControl')
    Remote('describe')(this.describe, { name: 'describe', static: false, private: false, addInitializer: fn => fn.call(this) } as ClassMethodDecoratorContext<RouterRemote, typeof this.describe>)
    Remote('listRuns')(this.listRuns, { name: 'listRuns', static: false, private: false, addInitializer: fn => fn.call(this) } as ClassMethodDecoratorContext<RouterRemote, typeof this.listRuns>)
    Remote('command')(this.command, { name: 'command', static: false, private: false, addInitializer: fn => fn.call(this) } as ClassMethodDecoratorContext<RouterRemote, typeof this.command>)
  }
  describe(request: unknown) { return this.ctx.modelRouter.describe(z.object({ sessionId: id }).strict().parse(request).sessionId) }
  listRuns(request: unknown) { return this.ctx.modelRouter.listRuns(runQuerySchema.parse(request)) }
  command(request: unknown) { return this.ctx.modelRouter.command(commandSchema.parse(request)) }
}

/** Mount the Host owner and its scoped delegation, review and reporting tools. */
export async function apply(ctx: Context, config: RouterConfig): Promise<void> {
  const router = new ModelRouter(ctx, config)
  new RouterRemote(ctx)
  ctx.inject(['sessionController', 'agentDefaultModel', 'sessionProjections', 'sessionQuery'], scope => { scope.effect(() => installSelectionBridge(scope, router), 'model router: reversible model selection bridge') })
  const tool = defineTool({
    name: DELEGATE_TOOL,
    description: 'Delegate one bounded task: search uses the light model (read-only), execute uses the normal model, expert uses the strong model (read-only). The main assistant remains responsible for verification. Provide all user/project constraints and sufficient context; children do not inherit this conversation. Use only when collaboration is enabled. Choose expert directly for complex analysis (complexity_direct). After a child returns, review its actual evidence. Use model_router_review_task with verified repairs if acceptance still fails; never invent evidence or delegate the same task again to reset limits.',
    parameters: {
      role: { type: 'string', enum: ['search', 'execute', 'expert'], required: true },
      reason: { type: 'string', required: true }, title: { type: 'string', required: true }, objective: { type: 'string', required: true },
      scope: { type: 'array', items: { type: 'string' }, required: true },
      acceptance: { type: 'array', items: { type: 'string' }, required: true },
      constraints: { type: 'array', items: { type: 'string' }, required: true }, context: { type: 'string', required: true },
    },
    // Read-only children may overlap. Admission mutates only the plugin's own
    // serialized aggregate; a full slot fails closed instead of oversubscribing.
    isConcurrencySafe: args => args.role !== 'execute',
    output: { schema: { type: 'object', properties: { taskId: { type: 'string', required: true }, executionId: { type: 'string' }, status: { type: 'string', required: true }, result: { type: 'string', required: true }, evidence: { type: 'string', required: true } }, additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('An active main agent is required.')
      return ctx.modelRouter.delegate(exec.agent, inputSchema.parse(args), exec.signal)
    },
  })
  const reviewTool = defineTool({
    name: REVIEW_TOOL,
    description: 'Main assistant only: semantically verify a settled child against acceptance A1, A2, etc. Supply Host evidence IDs for baseline, distinct repair action and later failed verification, plus failure category. Initial failure and test reruns are not repairs. Read actual results, distinguish missing dependencies/permissions from capability; report unresolved issues. Host validates evidence and may upgrade once. Use current executionId from the evidence. Fixed mode disables automatic upgrades.',
    parameters: { taskId: { type: 'string', required: true }, executionId: { type: 'string', required: true }, reviews: { type: 'json', required: true }, unresolved: { type: 'string', required: true }, contextSummary: { type: 'string' } },
    output: { schema: { type: 'object', properties: { taskId: { type: 'string', required: true }, executionId: { type: 'string' }, status: { type: 'string', required: true }, result: { type: 'string', required: true }, evidence: { type: 'string', required: true } }, additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('Main assistant required.')
      const parsed = z.object({ taskId: id, executionId: id, reviews: z.array(reviewSchema).max(20), unresolved: z.string().min(1).max(4000), contextSummary: z.string().min(1).max(16000).optional() }).strict().parse(args)
      return ctx.modelRouter.review(exec.agent, parsed, exec.signal)
    },
  })
  const taskTool = defineTool({
    name: TASK_TOOL,
    description: 'Manage the current collaboration objective. Only the main assistant may use action decision; delegated children must start their assigned work and use inspect/report only. Before edit/write/bash/run_code, the main assistant must call action decision with workType answer/small_change/research/implementation/diagnosis/analysis, strategy and a specific reason. Host rejects mutations until required managed work has happened: research requires search, implementation requires execute, diagnosis or analysis requires expert. action inspect reads owned results; use taskId/executionId/offset only for inspect. action report submits structured acceptance with taskId/executionId/report. Omit fields unrelated to the selected action. Children can report/inspect only themselves; the main must review every child before root success. This tool does not edit files or grant permission.',
    parameters: { action: { type: 'string', enum: ['decision', 'inspect', 'report'], required: true }, strategy: { type: 'string', enum: ['direct', 'delegate'] }, workType: { type: 'string', enum: ['answer', 'small_change', 'research', 'implementation', 'diagnosis', 'analysis'] }, reason: { type: 'string' }, taskId: { type: 'string' }, executionId: { type: 'string' }, offset: { type: 'number', description: 'Inspect lists page by 32; supply returned nextOffset to continue.' }, report: { type: 'json' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('An active managed assistant is required.')
      return ctx.modelRouter.taskAction(exec.agent, taskActionSchema.parse(args), exec.signal)
    },
  })
  let unregister: (() => void) | undefined
  const reconcile = () => {
    const current = snapshotRouterConfig(config)
    if (current.enabled && !unregister) { const removeDelegate = ctx.tools.register(tool); const removeReview = ctx.tools.register(reviewTool); const removeTask = ctx.tools.register(taskTool); unregister = () => { removeTask(); removeReview(); removeDelegate() } }
    else if (!current.enabled) { unregister?.(); unregister = undefined }
  }
  ctx.on('loader/volatile-update', () => { reconcile() })
  ctx.effect(() => { reconcile(); return () => { unregister?.(); unregister = undefined } }, 'model router: enabled delegation tool')
  await router.initialize()
}
