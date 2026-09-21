import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { evaluate, type Evaluation } from '../../src/model-router/evaluation.ts'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as Retry from '@deepseek-ai/dsh-llm-retry'
import { legacyDomainSpec, v2DomainSpec, v3DomainSpec, v4DomainSpec, domainSpec } from '../../src/model-router/host/storage.ts'
import { ledger } from '../../src/model-router/accounting.ts'
import type { RunRecord } from '../../src/model-router/shared.ts'
import PlanMode from '@deepseek-ai/dsh-plan-mode'
import Settings from '@deepseek-ai/dsh-settings'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as Domain from '@deepseek-ai/dsh-storage-domain'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as Router from '../../src/model-router/host/index.ts'
import { DELEGATE_TOOL, REVIEW_TOOL, TASK_TOOL, NAMESPACE, type RepairReview } from '../../src/model-router/shared.ts'
import { dshCheckout } from '../dsh-aliases.ts'

class MemorySettings extends Settings {
  readonly writable = true
  protected async load() { return {} }
  protected async persist() {}
}
const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose() })
const input = (role: string) => ({ role, reason: 'Independent bounded work needs this role.', title: `${role} task`, objective: 'Verify the public seam', scope: ['fixture'], acceptance: ['Report evidence'], constraints: ['Preserve user data'], context: 'Local fixture task.' })
class Adapter extends LlmAdapter {
  calls: { model: string; tools: string[] }[] = []
  constructor(private readonly delegate = true, private readonly forceWrite = false, private readonly slow = false) { super() }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const tools = options.tools?.map(t => t.name) ?? []
    this.calls.push({ model: options.model, tools })
    if (this.slow && !tools.includes(DELEGATE_TOOL)) await new Promise<void>(resolve => { if (options.signal?.aborted) resolve(); else options.signal?.addEventListener('abort', () => resolve(), { once: true }) })
    const prior = options.messages.some(m => m.role === 'tool' || m.content.some(b => b.type === 'tool-result'))
    if (this.delegate && tools.includes(DELEGATE_TOOL) && !prior) {
      for (const [index, role] of ['search', 'expert', 'execute'].entries()) {
        yield { type: 'block-start', index, blockType: 'tool-call', toolCallId: `task-${role}`, toolName: DELEGATE_TOOL }
        yield { type: 'block-end', index, block: { type: 'tool-call', id: `task-${role}`, name: DELEGATE_TOOL, arguments: JSON.stringify(input(role)) } }
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else if (this.forceWrite && !tools.includes(DELEGATE_TOOL) && !prior) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call', toolCallId: 'bad-write', toolName: 'write' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'bad-write', name: 'write', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Evidence collected.' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Evidence collected.' } }
      yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}
async function stack(options: { adapter?: Adapter; root?: string; maxRequests?: number; maxRunRecordBytes?: number; retryBefore?: boolean; legacy?: RunRecord; budget?: { tokenLimitEnabled: boolean; maxTotalTokens: number }; v2?: RunRecord } = {}) {
  const root = options.root ?? await mkdtemp(resolve(tmpdir(), 'router-stack-'))
  const ctx = new Context(); contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(resolve(dshCheckout, 'examples/package.json')).href
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] }); await ctx.plugin(Subagents); await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(MemorySettings); await ctx.plugin(Storage); await ctx.plugin(JsonStorage, { root }); await ctx.plugin(Domain, { backend: 'json' })
  const adapter = options.adapter ?? new Adapter()
  ctx.llm.registerAdapter(['fixture'], adapter)
  let writes = 0
  const removeWrite = ctx.tools.register(defineTool({ name: 'write', description: 'fixture writer', parameters: {}, output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] }, async execute() { writes++; return 'written' } }))
  const config = Router.Config({ enabled: true, models: { light: { provider: 'fixture', model: 'light' }, normal: { provider: 'fixture', model: 'normal' }, strong: { provider: 'fixture', model: 'strong' } }, budget: options.budget, limits: { maxRequests: options.maxRequests ?? 30 }, storage: { maxRunRecordBytes: options.maxRunRecordBytes ?? 2097152 } })
  if (options.retryBefore) await ctx.plugin(Retry, {})
  if (options.legacy) {
    const old = await ctx.storageDomain.open(legacyDomainSpec)
    await old.table('runs').put(options.legacy.id, options.legacy)
    await old.table('session_controls').put('parent', { revision: 0, mode: 'auto', activeRunId: options.legacy.id })
    await old.close()
  }
  if (options.v2) { const old = await ctx.storageDomain.open(v2DomainSpec); await old.table('runs').put(options.v2.id, options.v2); await old.table('session_controls').put('parent', { revision: 0, mode: 'auto', activeRunId: options.v2.id }); await old.close() }
  if (!options.legacy && !options.v2) { const seed = await ctx.storageDomain.open(domainSpec); await seed.table('session_controls').put('parent', { revision: 0, mode: 'auto', operationId: 'fixture-explicit-auto' }); await seed.close() }
  const fiber = await ctx.plugin(Router, config)
  await ctx.modelRouter.describe('parent')
  const { agent } = await ctx.agents.create({ sessionId: SessionId('parent'), meta: { cwd: root }, agentOptions: { provider: 'fixture', model: 'original' } })
  const send = async () => { agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Do the task' }], source: { kind: 'user' } })); await agent.whenIdle() }
  return { ctx, agent, fiber, adapter, root, send, removeWrite, writes: () => writes }
}

it('routes the real main loop and every first child request; records actual headers and disposes children', async () => {
  const s = await stack(); await s.send()
  const view = await s.ctx.modelRouter.describe('parent')
  expect(s.adapter.calls.map(c => c.model)).toEqual(['normal', 'light', 'strong', 'normal', 'normal'])
  expect(view.run?.tasks.map(t => t.status)).toEqual(['completed', 'completed', 'completed'])
  expect(view.run?.requests.map(r => r.actualModel?.model)).toEqual(['normal', 'light', 'strong', 'normal', 'normal'])
  expect(view.run?.requests.at(-1)?.usage).toEqual({ inputTokens: 7, outputTokens: 3, totalTokens: 10 })
  expect(s.ctx.agents.list().map(a => a.id)).toEqual(['parent'])
  for (const child of s.adapter.calls.slice(1, 4)) expect(child.tools).not.toContain(DELEGATE_TOOL)
}, 15000)

it('fixed mode overrides the main and all role requests, and stale controls cannot replace it', async () => {
  const s = await stack()
  await s.ctx.modelRouter.command({ sessionId: 'parent', expectedRevision: 0, operationId: 'fixed', action: 'mode', mode: 'fixed', fixedModel: { provider: 'fixture', model: 'chosen' } })
  await expect(s.ctx.modelRouter.command({ sessionId: 'parent', expectedRevision: 0, operationId: 'stale', action: 'mode', mode: 'auto' })).rejects.toThrow('conflict')
  await s.send()
  expect(s.adapter.calls.map(c => c.model)).toEqual(Array(5).fill('chosen'))
})

it('denies forced write calls from read-only children but permits the executor', async () => {
  const s = await stack({ adapter: new Adapter(true, true) }); await s.send()
  expect(s.writes()).toBe(1)
  expect(s.adapter.calls.find(c => c.model === 'light')?.tools).not.toContain('write')
  expect(s.adapter.calls.find(c => c.model === 'strong')?.tools).not.toContain('write')
})

it('blocks a main mutation until it records a work type and completes the required role', async () => {
  class CheckpointAdapter extends Adapter {
    private steps = new Map<string, number>()
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const main = options.tools?.some(tool => tool.name === DELEGATE_TOOL) ?? false
      const identity = options.sessionId ?? options.model
      const step = this.steps.get(identity) ?? 0
      this.steps.set(identity, step + 1)
      this.calls.push({ model: options.model, tools: options.tools?.map(tool => tool.name) ?? [] })
      let name: string | undefined
      let args: Record<string, unknown> = {}
      if (main && step === 0) name = 'write'
      else if (main && step === 1) {
        name = TASK_TOOL
        args = { action: 'decision', strategy: 'delegate', workType: 'implementation', reason: 'The requested change needs an execution model.' }
      } else if (main && step === 2) {
        name = DELEGATE_TOOL
        args = input('execute')
      } else if (main && step === 3) name = 'write'
      if (name) {
        const id = `checkpoint-${identity}-${step}`
        yield { type: 'block-start', index: 0, blockType: 'tool-call', toolCallId: id, toolName: name }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Done.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const s = await stack({ adapter: new CheckpointAdapter() })
  await s.send()
  expect(s.writes()).toBe(1)
  const run = (await s.ctx.modelRouter.describe('parent')).run!
  expect(run.decision).toMatchObject({ workType: 'implementation', strategy: 'delegate' })
  expect(run.tasks).toHaveLength(1)
  expect(run.tasks[0]?.role).toBe('execute')
  expect(s.adapter.calls.map(call => call.model)).toEqual(Array(6).fill('normal'))
})

it('keeps request history across user followups and restart without replay', async () => {
  const s = await stack({ adapter: new Adapter(false), maxRequests: 2 })
  await s.send(); await s.send(); await s.send()
  expect(s.adapter.calls).toHaveLength(3)
  const before = await s.ctx.modelRouter.describe('parent')
  await s.fiber.dispose()
  const fiber = await s.ctx.plugin(Router, Router.Config({ enabled: false }))
  const after = await s.ctx.modelRouter.describe('parent')
  expect(after.run?.requests).toEqual(before.run?.requests)
  expect(s.adapter.calls).toHaveLength(3)
  await fiber.dispose()
  expect(s.ctx.tools.get(DELEGATE_TOOL)).toBeUndefined()
})

it('runs two read-only children concurrently and cancels both before unloading', async () => {
  const s = await stack({ adapter: new Adapter(true, false, true) })
  const sending = s.send()
  await vi.waitFor(() => expect(s.adapter.calls.length).toBe(3))
  await s.ctx.modelRouter.command({ sessionId: 'parent', expectedRevision: 0, operationId: 'stop', action: 'cancel' })
  await sending
  expect(s.ctx.agents.list().map(a => a.id)).toEqual(['parent'])
  expect((await s.ctx.modelRouter.describe('parent')).run?.status).toBe('cancelled')
  await s.fiber.dispose()
  expect(s.ctx.get('modelRouter')).toBeUndefined()
}, 15000)

it('uses standard settings revision fences and unset restores deployment inheritance', async () => {
  const s = await stack()
  const revision = s.ctx.settings.describe().find(row => row.ns === NAMESPACE)!.revision
  await s.ctx.settings.mutate(NAMESPACE, [{ op: 'set', path: ['limits', 'maxConcurrentChildren'], value: 3 }], revision)
  await expect(s.ctx.settings.mutate(NAMESPACE, [{ op: 'set', path: ['enabled'], value: false }], revision)).rejects.toThrow()
  await s.ctx.settings.mutate(NAMESPACE, [{ op: 'unset', path: ['limits', 'maxConcurrentChildren'] }])
  expect(s.ctx.settings.get(NAMESPACE)).toMatchObject({ limits: { maxConcurrentChildren: 2 } })
})

it('off mode hides delegation and restores the original route after a managed turn', async () => {
  const s = await stack({ adapter: new Adapter(false) }); await s.send()
  await s.ctx.modelRouter.command({ sessionId: 'parent', expectedRevision: 0, operationId: 'off', action: 'mode', mode: 'off' })
  await s.send()
  expect(s.adapter.calls.map(c => c.model)).toEqual(['normal', 'original'])
  expect(s.adapter.calls[1]?.tools).not.toContain(DELEGATE_TOOL)
  expect((await s.ctx.modelRouter.describe('parent')).run?.requests).toHaveLength(1)
})

it('keeps active defaults stable; explicit new objectives use changed settings', async () => {
  const s = await stack({ adapter: new Adapter(false) }); await s.send()
  await s.ctx.settings.mutate(NAMESPACE, [{ op: 'set', path: ['models', 'normal', 'model'], value: 'changed' }])
  await s.send()
  const before = await s.ctx.modelRouter.describe('parent')
  expect(s.adapter.calls.map(c => c.model)).toEqual(['normal', 'normal'])
  await s.ctx.modelRouter.command({ sessionId: 'parent', expectedRevision: 0, operationId: 'new-objective', action: 'new' })
  await s.send()
  const after = await s.ctx.modelRouter.describe('parent')
  expect(after.run?.id).not.toBe(before.run?.id)
  expect(after.run?.requests).toHaveLength(1)
  expect(s.adapter.calls.at(-1)?.model).toBe('changed')
})

it('allows identical model slots while preserving role restrictions', async () => {
  const s = await stack()
  await s.ctx.settings.mutate(NAMESPACE, [{ op: 'set', path: ['models'], value: Object.fromEntries(['light', 'normal', 'strong'].map(tier => [tier, { provider: 'fixture', model: 'same' }])) }])
  await s.send()
  expect(s.adapter.calls.every(c => c.model === 'same')).toBe(true)
  expect((await s.ctx.modelRouter.describe('parent')).run?.tasks.map(t => t.role)).toEqual(['search', 'expert', 'execute'])
})

it('applies a fixed model on the next request without rewriting historical facts', async () => {
  const s = await stack({ adapter: new Adapter(false) }); await s.send()
  await s.ctx.modelRouter.command({ sessionId: 'parent', expectedRevision: 0, operationId: 'fixed-next', action: 'mode', mode: 'fixed', fixedModel: { provider: 'fixture', model: 'strong' } })
  await s.send()
  expect((await s.ctx.modelRouter.describe('parent')).run?.requests.map(r => r.actualModel?.model)).toEqual(['normal', 'strong'])
})

it('fences simultaneous first-use controls instead of overwriting the winning revision', async () => {
  const s = await stack({ adapter: new Adapter(false) })
  const results = await Promise.allSettled(['a', 'b'].map(operationId => s.ctx.modelRouter.command({ sessionId: 'parent', expectedRevision: 0, operationId, action: 'mode', mode: 'off' })))
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  expect((await s.ctx.modelRouter.describe('parent')).control.revision).toBe(1)
})

it('unloads during provider preparation without a late model request or retained child', async () => {
  const s = await stack({ adapter: new Adapter(false) })
  let entered!: () => void; const preparing = new Promise<void>(resolve => { entered = resolve })
  vi.spyOn(s.adapter, 'prepareCall').mockImplementation(async (_provider, _model, signal) => {
    entered(); await new Promise<void>(resolve => { if (signal?.aborted) resolve(); else signal?.addEventListener('abort', () => resolve(), { once: true }) })
    signal?.throwIfAborted(); throw new Error('aborted')
  })
  const sending = s.send(); await preparing; await s.fiber.dispose(); await sending
  expect(s.adapter.calls).toHaveLength(0)
  expect(s.ctx.tools.get(DELEGATE_TOOL)).toBeUndefined()
})

it('limits retries even if another recovery listener keeps requesting retry', async () => {
  const s = await stack({ adapter: new Adapter(false) })
  let attempts = 0
  vi.spyOn(s.adapter, 'stream').mockImplementation(async function* () {
    attempts++
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'fixture temporary error' } } }
  })
  s.ctx.on('agent/request-error', async () => ({ kind: 'retry' }))
  await s.send()
  expect(attempts).toBeLessThanOrEqual(3)
  expect(attempts).toBeGreaterThan(1)
  expect((await s.ctx.modelRouter.describe('parent')).run?.requests).toHaveLength(attempts)
})

it('does not expose the model tool while globally disabled, and reenables without duplicate registration', async () => {
  const s = await stack({ adapter: new Adapter(false) })
  await s.ctx.settings.mutate(NAMESPACE, [{ op: 'set', path: ['enabled'], value: false }])
  expect(s.ctx.tools.get(DELEGATE_TOOL)).toBeUndefined()
  expect(await s.ctx.modelRouter.managesSelection('parent')).toBe(false)
  await s.send(); expect(s.adapter.calls[0]?.model).toBe('original')
  await s.ctx.settings.mutate(NAMESPACE, [{ op: 'set', path: ['enabled'], value: true }])
  expect(await s.ctx.modelRouter.managesSelection('parent')).toBe(true)
  await s.send(); expect(s.adapter.calls[1]?.model).toBe('normal')
})

it('denies background shell execution rather than leaving jobs behind the root cancellation boundary', async () => {
  const s = await stack({ adapter: new Adapter(false) }); await s.send()
  let dispatched = false
  s.ctx.tools.register(defineTool({ name: 'bash', description: 'fixture shell', parameters: { run_in_background: { type: 'boolean' } }, output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] }, async execute() { dispatched = true; return 'background job' } }))
  const result = await s.ctx.tools.execute({ agent: s.agent, callId: ToolCallId('background'), name: 'bash', arguments: { run_in_background: true }, signal: new AbortController().signal })
  expect(result.isError).toBe(true); expect(dispatched).toBe(false)
})

it('completes 35 requests and 17 child executions, then resumes a legacy capped run', async () => {
  class LongAdapter extends Adapter {
    issued = 0
    constructor() { super(false) }
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const tools = options.tools?.map(tool => tool.name) ?? []
      if (tools.includes(DELEGATE_TOOL) && this.issued < 17) {
        this.calls.push({ model: options.model, tools })
        const id = `long-${this.issued++}`
        yield { type: 'block-start', index: 0, blockType: 'tool-call', toolCallId: id, toolName: DELEGATE_TOOL }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: DELEGATE_TOOL, arguments: JSON.stringify(input('search')) } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else { yield* super.stream(options) }
    }
  }
  const s = await stack({ adapter: new LongAdapter(), maxRequests: 30 })
  await s.send()
  const run = (await s.ctx.modelRouter.describe('parent')).run!
  expect(s.adapter.calls).toHaveLength(35)
  expect(run.childExecutions).toBe(17)
  expect(run.tasks.every(task => task.status === 'completed')).toBe(true)
  expect(run.blockedReason).toBeUndefined()
  expect(run.config.limits).toMatchObject({ maxRequests: 0, maxChildExecutions: 0 })
  const legacy = structuredClone(run)
  legacy.status = 'paused'; legacy.blockedReason = 'request-limit'
  legacy.config.limits.maxRequests = 30; legacy.config.limits.maxChildExecutions = 12
  const resumed = await stack({ v2: legacy })
  await expect(resumed.ctx.modelRouter.command({ sessionId: 'parent', action: 'allowance', expectedRevision: 0, operationId: 'obsolete', addRequests: 5 })).rejects.toThrow('removed')
  await resumed.ctx.modelRouter.command({ sessionId: 'parent', action: 'continue', expectedRevision: 0, operationId: 'resume-long-task' })
  await resumed.agent.whenIdle()
  const after = (await resumed.ctx.modelRouter.describe('parent')).run!
  expect(after.id).toBe(run.id)
  expect(after.requests.length).toBeGreaterThan(35)
  expect(after.childExecutions).toBeGreaterThan(17)
  expect(after.blockedReason).toBeUndefined()
}, 20000)

class RepairAdapter extends Adapter {
  prompts: string[] = []
  childSteps = 0
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const tools = options.tools?.map(t => t.name) ?? []
    this.calls.push({ model: options.model, tools })
    this.prompts.push(JSON.stringify(options.messages))
    const prior = options.messages.some(m => m.role === 'tool' || m.content.some(b => b.type === 'tool-result'))
    let tool: string | undefined; let args: Record<string, unknown> = {}
    if (tools.includes(DELEGATE_TOOL) && !prior) { tool = DELEGATE_TOOL; args = input('execute') }
    else if (!tools.includes(DELEGATE_TOOL) && options.model === 'normal' && this.childSteps < 5) {
      const step = this.childSteps++
      tool = step % 2 ? 'write' : 'bash'
      args = step % 2 ? { text: `repair ${step}` } : { command: 'verify fixture' }
    }
    if (tool) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call', toolCallId: `repair-${this.calls.length}`, toolName: tool }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `repair-${this.calls.length}`, name: tool, arguments: JSON.stringify(args) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Two distinct repairs; A1 remains unsatisfied. Inspect the test evidence.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}
async function repairStack(maxRunRecordBytes?: number) {
  const adapter = new RepairAdapter()
  const s = await stack({ adapter, maxRunRecordBytes })
  s.removeWrite()
  // Replace the test writer only: actual file changes make handoff observable.
  s.ctx.tools.register(defineTool({ name: 'write', description: 'repair fixture', parameters: { text: { type: 'string', required: true } }, output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] }, async execute(args) { await writeFile(resolve(s.root, 'fixture'), args.text); return args.text } }))
  s.ctx.tools.register(defineTool({ name: 'bash', description: 'acceptance fixture', parameters: { command: { type: 'string', required: true } }, output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] }, async execute() { return 'exit_code=1; A1 assertion mismatch; dependencies present' } }))
  await s.send()
  const task = (await s.ctx.modelRouter.describe('parent')).run!.tasks[0]!
  expect(task.evidence).toHaveLength(5)
  const e = task.evidence!
  const reviews: RepairReview[] = [1, 3].map(index => ({ acceptanceId: 'A1', category: 'capability', baseline: e[0]!.id, action: e[index]!.id, verification: e[index + 1]!.id, explanation: `Distinct repair ${index} still fails the task-owned assertion.` }))
  return { ...s, task, reviews, review: () => s.ctx.modelRouter.review(s.agent, { taskId: task.id, executionId: task.executionId, reviews, unresolved: 'A1 assertion still fails. Preserve prior file modifications.' }, new AbortController().signal) }
}

it('upgrades only after verified repairs, preserves task identity and hands off existing changes', async () => {
  const s = await repairStack()
  const output = await s.ctx.tools.execute({ agent: s.agent, callId: ToolCallId('review-upgrade'), name: REVIEW_TOOL,
    arguments: { taskId: s.task.id, executionId: s.task.executionId, reviews: s.reviews, unresolved: 'A1 still fails; preserve the current files.' }, signal: new AbortController().signal })
  expect(output.isError).toBe(false)
  if (output.isError) throw new Error('Review tool failed')
  expect(output.value).toMatchObject({ status: 'completed', taskId: s.task.id })
  const run = (await s.ctx.modelRouter.describe('parent')).run!
  const task = run.tasks[0]!
  expect(run.tasks).toHaveLength(1); expect(run.childExecutions).toBe(2)
  expect(task.executions).toHaveLength(2); expect(task.escalations).toBe(1)
  expect(task.executions?.[1]?.actualModel?.model).toBe('strong')
  expect(task.executions?.[1]?.handoff).toContain('Preserve user data')
  expect(task.executions?.[1]?.handoff).toContain(s.task.executionId)
  expect(await readFile(resolve(s.root, 'fixture'), 'utf8')).toBe('repair 3')
  expect(s.adapter.childSteps).toBe(5)
  expect(s.ctx.agents.list()).toHaveLength(1)
  expect(run.requests.at(-1)?.reason).toBe('capability_upgrade')
  await expect(s.review()).rejects.toThrow('current settled')
})

it('records environment reviews without upgrading; fixed mode overrides valid evidence', async () => {
  const s = await repairStack()
  await s.ctx.modelRouter.command({ sessionId: 'parent', expectedRevision: 0, operationId: 'fixed-review', action: 'mode', mode: 'fixed', fixedModel: { provider: 'fixture', model: 'light' } })
  expect((await s.review()).status).toBe('manual_override')
  expect((await s.ctx.modelRouter.describe('parent')).run!.childExecutions).toBe(1)
})

it('detects external scoped file changes before an upgrade and never replays writes', async () => {
  const s = await repairStack()
  await writeFile(resolve(s.root, 'fixture'), 'external user change')
  expect((await s.review()).status).toBe('workspace_changed')
  expect(await readFile(resolve(s.root, 'fixture'), 'utf8')).toBe('external user change')
})

it('retries the same role model and ignores legacy backup configuration', async () => {
  const s = await stack({ adapter: new Adapter(false) })
  await s.ctx.settings.mutate(NAMESPACE, [{ op: 'set', path: ['routing', 'fallbacks', 'normal'], value: [{ provider: 'removed-provider', model: 'backup' }] }])
  const called: string[] = []
  vi.spyOn(s.adapter, 'stream').mockImplementation(async function* (options) {
    called.push(options.model)
    if (called.length === 1) yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', status: 503, message: 'fixture transient' } } }
    else { yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'block-end', index: 0, block: { type: 'text', text: 'recovered' } }; yield { type: 'finish', reason: { kind: 'stop' } } }
  })
  await s.send(); await s.send()
  expect(called).toEqual(['normal', 'normal', 'normal'])
  const run = (await s.ctx.modelRouter.describe('parent')).run!
  expect(run.requests[0]?.failureKind).toBe('network')
  expect(run.requests[1]?.reason).toBe('role_default')
  expect(run.requests[1]?.actualModel?.model).toBe('normal')
  expect(run.config.routing.fallbacks).toEqual({ light: [], normal: [], strong: [] })
})

it('ignores backups stored in an old task snapshot while retaining bounded retries', async () => {
  const source = await stack({ adapter: new Adapter(false) }); await source.send()
  const old = (await source.ctx.modelRouter.describe('parent')).run!
  old.config.routing.fallbacks.normal = [{ provider: 'fixture', model: 'backup' }]
  // The test stack creates a fresh agent; keep historical turns distinct from its first turn.
  for (const request of old.requests) request.turn = -1
  const s = await stack({ adapter: new Adapter(false), v2: old })
  const called: string[] = []
  vi.spyOn(s.adapter, 'stream').mockImplementation(async function* (options) { called.push(options.model); yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', status: 503, message: 'fixture transient' } } } })
  await s.ctx.modelRouter.command({ sessionId: 'parent', expectedRevision: 0, operationId: 'continue-old-backups', action: 'continue' })
  await s.agent.whenIdle()
  expect(called).toEqual(['normal', 'normal', 'normal'])
})

it.each([['AUTH', 401], ['RATE_LIMIT', 429], ['PERMISSION_DENIED', 403]] as const)('does not switch providers for %s', async (code, status) => {
  const s = await stack({ adapter: new Adapter(false) })
  await s.ctx.settings.mutate(NAMESPACE, [{ op: 'set', path: ['routing', 'fallbacks', 'normal'], value: [{ provider: 'fixture', model: 'backup' }] }])
  const called: string[] = []
  vi.spyOn(s.adapter, 'stream').mockImplementation(async function* (options) { called.push(options.model); yield { type: 'finish', reason: { kind: 'error', failure: { code, status, message: 'fixture failure' } } } })
  await s.send()
  expect(called).toEqual(['normal'])
})


it('records missing dependencies without capability upgrades and deduplicates repeated evidence', async () => {
  const s = await repairStack()
  const reviews = s.reviews.map(r => ({ ...r, category: 'environment' as const }))
  const args = { taskId: s.task.id, executionId: s.task.executionId, reviews, unresolved: 'Missing test dependency.' }
  expect((await s.ctx.modelRouter.review(s.agent, args, new AbortController().signal)).status).toBe('insufficient_evidence')
  await s.ctx.modelRouter.review(s.agent, args, new AbortController().signal)
  expect((await s.ctx.modelRouter.describe('parent')).run!.tasks[0]!.reviews).toHaveLength(2)
})

it('honors a manual fixed revision arriving while upgrade preflight is pending', async () => {
  const s = await repairStack()
  const original = s.adapter.prepareCall.bind(s.adapter)
  let entered!: () => void; let release!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve }); const gate = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(s.adapter, 'prepareCall').mockImplementation(async (...args) => { if (args[1] === 'strong') { entered(); await gate }; return original(...args) })
  const review = s.review(); await waiting
  await s.ctx.modelRouter.command({ sessionId: 'parent', expectedRevision: 0, operationId: 'fixed-during-upgrade', action: 'mode', mode: 'fixed', fixedModel: { provider: 'fixture', model: 'light' } })
  release()
  expect((await review).status).toBe('manual_override')
  expect((await s.ctx.modelRouter.describe('parent')).run!.tasks[0]!.escalations).toBe(0)
})

it('uses real plan-mode state and blocks writes until explicit exit; fixed mode still wins', async () => {
  const s = await stack({ adapter: new Adapter(false) })
  await s.ctx.plugin(PlanMode, { section: 'Plan only; obtain approval before edits.' })
  await s.ctx.settings.mutate(NAMESPACE, [{ op: 'set', path: ['routing', 'phaseSwitch'], value: true }])
  s.ctx.planMode.set(s.agent, true)
  await s.send()
  expect(s.adapter.calls.at(-1)?.model).toBe('strong')
  const denied = await s.ctx.tools.execute({ agent: s.agent, callId: ToolCallId('unapproved'), name: 'write', arguments: {}, signal: new AbortController().signal })
  expect(denied.isError).toBe(true); expect(s.writes()).toBe(0)
  // Explicit user/service action, not model-generated text.
  s.ctx.planMode.set(s.agent, false); await s.send()
  expect(s.adapter.calls.at(-1)?.model).toBe('normal')
  s.ctx.planMode.set(s.agent, true)
  await s.ctx.modelRouter.command({ sessionId: 'parent', expectedRevision: 0, operationId: 'fixed-plan', action: 'mode', mode: 'fixed', fixedModel: { provider: 'fixture', model: 'light' } })
  await s.send(); expect(s.adapter.calls.at(-1)?.model).toBe('light')
  expect((await s.ctx.modelRouter.describe('parent')).phaseAvailable).toBe(true)
})

it('rejects phase switching when the public planning owner is absent', async () => {
  const s = await stack({ adapter: new Adapter(false) })
  await expect(s.ctx.settings.mutate(NAMESPACE, [{ op: 'set', path: ['routing', 'phaseSwitch'], value: true }])).rejects.toThrow()
  expect((await s.ctx.modelRouter.describe('parent')).phaseAvailable).toBe(false)
})


it('integrates with the real DSH retry owner without multiplying the same-model attempt limit', async () => {
  const s = await stack({ adapter: new Adapter(false), retryBefore: true })
  await s.ctx.settings.mutate(NAMESPACE, [{ op: 'set', path: ['routing', 'fallbacks', 'normal'], value: [{ provider: 'fixture', model: 'backup1' }, { provider: 'fixture', model: 'backup2' }] }])
  vi.spyOn(s.adapter, 'providerRetryPolicy').mockReturnValue({ mode: 'always', initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 })
  const called: string[] = []
  vi.spyOn(s.adapter, 'stream').mockImplementation(async function* (options) { called.push(options.model); yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', status: 503, message: 'fixture transient' } } } })
  await s.send()
  expect(called).toEqual(['normal', 'normal', 'normal'])
  expect((await s.ctx.modelRouter.describe('parent')).run!.requests).toHaveLength(3)
})

it('cancels a same-model retry wait without dispatching another request', async () => {
  const s = await stack({ adapter: new Adapter(false) })
  await s.ctx.settings.mutate(NAMESPACE, [{ op: 'set', path: ['routing', 'fallbacks', 'normal'], value: [{ provider: 'fixture', model: 'backup' }] }])
  const called: string[] = []
  vi.spyOn(s.adapter, 'stream').mockImplementation(async function* (options) { called.push(options.model); yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', providerRetryAfterMs: 10000, message: 'fixture wait' } } } })
  const sending = s.send()
  await vi.waitFor(async () => expect((await s.ctx.modelRouter.describe('parent')).run?.requests[0]?.failureCode).toBe('SERVER'))
  await s.ctx.modelRouter.command({ sessionId: 'parent', expectedRevision: 0, operationId: 'cancel-wait', action: 'cancel' })
  await sending
  expect(called).toEqual(['normal'])
  expect((await s.ctx.modelRouter.describe('parent')).run!.status).toBe('cancelled')
})

it('copies legacy history once without modifying the V1 domain or enabling new routing on old runs', async () => {
  const source = await stack({ adapter: new Adapter(false) }); await source.send()
  const legacy = structuredClone((await source.ctx.modelRouter.describe('parent')).run!)
  legacy.config.routing.autoUpgrade = false
  const s = await stack({ adapter: new Adapter(false), legacy })
  const imported = (await s.ctx.modelRouter.describe('parent')).run!
  expect(imported.id).toBe(legacy.id); expect(imported.requests).toEqual(legacy.requests)
  expect(imported.config.routing.autoUpgrade).toBe(false)
  const old = await s.ctx.storageDomain.open(legacyDomainSpec)
  expect(old.table('runs').get(legacy.id)).toEqual(legacy)
  await old.close()
  await s.send()
  expect((await s.ctx.modelRouter.describe('parent')).run!.requests.length).toBe(legacy.requests.length + 1)
})


it('reads an isolated agent-scoped planning owner and fails closed after its removal', async () => {
  const s = await stack({ adapter: new Adapter(false) })
  const planningScope = s.agent.ctx.isolate('planMode')
  const plan = await planningScope.plugin(PlanMode, { section: 'Plan before writing.' })
  expect(s.agent.ctx.get('planMode')).toBeUndefined()
  await s.ctx.settings.mutate(NAMESPACE, [{ op: 'set', path: ['routing', 'phaseSwitch'], value: true }])
  planningScope.get('planMode')!.set(s.agent, true)
  await s.send()
  expect(s.adapter.calls.at(-1)?.model).toBe('strong')
  await plan.dispose()
  expect((await s.ctx.modelRouter.describe('parent')).phaseAvailable).toBe(false)
  await s.send()
  expect(s.adapter.calls).toHaveLength(1)
})


it('reserves both result copies and measures escaped JSON before storing child output', async () => {
  const s = await repairStack(65536)
  const original = s.adapter.stream.bind(s.adapter)
  vi.spyOn(s.adapter, 'stream').mockImplementation(async function* (options) {
    if (options.model !== 'strong') { yield* original(options); return }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '\n'.repeat(16000) } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  await s.review()
  const run = (await s.ctx.modelRouter.describe('parent')).run!
  expect(run.tasks[0]?.result).toContain('exceeds inline record limit')
  expect(run.tasks[0]?.executions?.at(-1)?.status).toBe('completed')
  expect(Buffer.byteLength(JSON.stringify(run))).toBeLessThan(65536)
})

class BoundedAdapter extends Adapter {
  override resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100 } }) }
}

it('ignores retired token settings for bounded and unbounded models', async () => {
  for (const adapter of [new BoundedAdapter(false), new Adapter(false)]) {
    const s = await stack({ adapter, budget: { tokenLimitEnabled: true, maxTotalTokens: 1 } })
    await s.send(); await s.send()
    const run = (await s.ctx.modelRouter.describe('parent')).run!
    expect(s.adapter.calls).toHaveLength(2)
    expect(run.blockedReason).toBeUndefined()
    expect(run.config.budget.tokenLimitEnabled).toBe(false)
    expect(run.requests.every(request => request.reservedTokens === undefined)).toBe(true)
    expect(ledger(run).reported).toBe(20)
  }
})

it('continues a legacy token-blocked run without asking for token allowance', async () => {
  const source = await stack({ adapter: new Adapter(false) }); await source.send()
  const legacy = structuredClone((await source.ctx.modelRouter.describe('parent')).run!)
  legacy.status = 'paused'; legacy.blockedReason = 'token-capability'
  legacy.config.budget = { tokenLimitEnabled: true, maxTotalTokens: 1 }
  const restored = await stack({ adapter: new Adapter(false), v2: legacy })
  await restored.ctx.modelRouter.command({ sessionId: 'parent', action: 'continue', expectedRevision: 0, operationId: 'resume-retired-limit' })
  await restored.agent.whenIdle()
  await restored.send()
  const run = (await restored.ctx.modelRouter.describe('parent')).run!
  expect(run.id).toBe(legacy.id)
  expect(run.blockedReason).toBeUndefined()
  expect(restored.adapter.calls.length).toBeGreaterThan(0)
})

it('does not double-settle a duplicate stream end or associate it with the next attempt', async () => {
  const s = await stack({ adapter: new BoundedAdapter(false) })
  let end: Parameters<Parameters<typeof s.ctx.on<'agent/assistant-stream'>>[1]>[0] | undefined
  s.ctx.on('agent/assistant-stream', payload => { if (payload.frame.type === 'end') end = payload })
  await s.send()
  const first = structuredClone((await s.ctx.modelRouter.describe('parent')).run!.requests)
  if (!end) throw new Error('Missing fixture stream end')
  const previous = end
  await s.send()
  s.ctx.emit('agent/assistant-stream', previous)
  await vi.waitFor(async () => expect((await s.ctx.modelRouter.describe('parent')).run!.requests[0]).toEqual(first[0]))
  expect(ledger((await s.ctx.modelRouter.describe('parent')).run!).reported).toBe(20)
})

it('paginates session-bound runs with stable cursors and exact model/role/status filters', async () => {
  const s = await stack({ adapter: new Adapter(false) })
  for (let i = 0; i < 12; i++) {
    if (i) await s.ctx.modelRouter.command({ sessionId: 'parent', expectedRevision: i - 1, operationId: `new-${i}`, action: 'new' })
    await s.send()
  }
  const first = await s.ctx.modelRouter.listRuns({ sessionId: 'parent', role: 'main', model: 'fixture/normal', status: 'completed' })
  expect(first.runs).toHaveLength(10); expect(first.nextCursor).toBeTruthy()
  const second = await s.ctx.modelRouter.listRuns({ sessionId: 'parent', role: 'main', model: 'fixture/normal', status: 'completed', cursor: first.nextCursor })
  expect(second.runs).toHaveLength(2); expect(new Set([...first.runs, ...second.runs].map(r => r.id)).size).toBe(12)
  await expect(s.ctx.modelRouter.listRuns({ sessionId: 'other', cursor: first.nextCursor })).rejects.toThrow('cursor')
  expect((await s.ctx.modelRouter.listRuns({ sessionId: 'other' })).runs).toEqual([])
  expect((await s.ctx.modelRouter.listRuns({ sessionId: 'parent', role: 'expert' })).runs).toEqual([])
})

it('imports V2 records read-only and retains interrupted reservations across restart', async () => {
  const original = await stack({ adapter: new BoundedAdapter(false) }); await original.send()
  const prior = structuredClone((await original.ctx.modelRouter.describe('parent')).run!)
  prior.status = 'running'; prior.requests[0]!.reservedTokens = 100; prior.requests[0]!.status = 'applied'; delete prior.requests[0]!.usage; delete prior.requests[0]!.streamSettled
  const migrated = await stack({ adapter: new BoundedAdapter(false), v2: prior })
  const restored = (await migrated.ctx.modelRouter.describe('parent')).run!
  expect(restored.status).toBe('interrupted'); expect(ledger(restored).uncertain).toBe(100); expect(migrated.adapter.calls).toHaveLength(0)
  const old = await migrated.ctx.storageDomain.open(v2DomainSpec)
  expect(old.table('runs').get(prior.id)).toEqual(prior); await old.close()
})

it('compares matched fixed-normal, fixed-strong and auto trials through real DSH loops', async () => {
  const samples: Evaluation['samples'] = []
  for (const task of ['direct-answer', 'three-role-delegation']) for (let repetition = 1; repetition <= 3; repetition++) {
    for (const group of ['normal', 'strong', 'auto'] as const) {
      const s = await stack({ adapter: new BoundedAdapter(task !== 'direct-answer') })
      if (group !== 'auto') await s.ctx.modelRouter.command({ sessionId: 'parent', expectedRevision: 0, operationId: 'benchmark-mode', action: 'mode', mode: 'fixed', fixedModel: { provider: 'fixture', model: group } })
      const start = performance.now(); await s.send()
      await vi.waitFor(async () => expect((await s.ctx.modelRouter.describe('parent')).run?.status).toBe('completed'))
      const run = (await s.ctx.modelRouter.describe('parent')).run!
      const actual = run.requests.map(r => r.actualModel?.model)
      const expected = task === 'direct-answer' ? [group === 'auto' ? 'normal' : group] : group === 'auto' ? ['normal', 'light', 'strong', 'normal', 'normal'] : Array(5).fill(group)
      expect(actual).toEqual(expected)
      expect(run.tasks.every(t => t.status === 'completed')).toBe(true)
      samples.push({ task, repetition, group, inputHash: task, workspaceHash: 'empty-fixture-workspace', environment: 'real DSH loop + deterministic keyless adapter', elapsedMs: performance.now() - start, passed: true, evidence: 'Actual model headers match expected route; every delegated task settled successfully.', run })
      await s.fiber.dispose()
    }
  }
  const data: Evaluation = { kind: 'deterministic-fixture', pluginRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() + '+working-tree-v3', dshRevision: execFileSync('git', ['-C', dshCheckout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), samples }
  const report = evaluate(data)
  expect(report.groups.map(g => g.passed)).toEqual([6, 6, 6])
  await mkdir('.verify-dsh-home/model-router-v3-evaluation', { recursive: true })
  await writeFile('.verify-dsh-home/model-router-v3-evaluation/samples.json', JSON.stringify(data, null, 2))
  await writeFile('.verify-dsh-home/model-router-v3-evaluation/report.json', JSON.stringify(report, null, 2))
}, 30000)

it('accounts auxiliary compaction beyond the retired request cap', async () => {
  const s = await stack({ adapter: new BoundedAdapter(false), maxRequests: 2, budget: { tokenLimitEnabled: true, maxTotalTokens: 120 } })
  await s.ctx.modelRouter.command({ sessionId: 'parent', expectedRevision: 0, operationId: 'fixed-aux', action: 'mode', mode: 'fixed', fixedModel: { provider: 'fixture', model: 'strong' } })
  await s.send()
  const compact = async () => { for await (const _ of s.ctx.llm.stream({ provider: 'fixture', model: 'normal', sessionId: s.agent.id, purpose: 'compaction', messages: [] })) { /* Drain actual adapter stream. */ } }
  await compact()
  const run = (await s.ctx.modelRouter.describe('parent')).run!
  expect(s.adapter.calls.map(c => c.model)).toEqual(['strong', 'strong'])
  expect(run.requests.at(-1)).toMatchObject({ purpose: 'compaction', usageState: 'reported' })
  expect(ledger(run).reported).toBe(20)
  await compact()
  expect(s.adapter.calls).toHaveLength(3)
  expect((await s.ctx.modelRouter.describe('parent')).run?.requests).toHaveLength(3)
})

it('does not snapshot retired prices on new requests', async () => {
  const s = await stack({ adapter: new BoundedAdapter(false) })
  const price = { provider: 'fixture', model: 'normal', currency: 'USD', input: 2, output: 4, source: 'https://example.com/fixture-only', version: 'fixture-1', updatedAt: 1, expiresAt: Date.now() + 60000 }
  await s.ctx.settings.mutate(NAMESPACE, [{ op: 'set', path: ['prices'], value: [price] }])
  await s.send()
  await s.ctx.settings.mutate(NAMESPACE, [{ op: 'set', path: ['prices'], value: [{ ...price, version: 'fixture-2', input: 9 }] }])
  await s.send()
  expect((await s.ctx.modelRouter.describe('parent')).run!.requests.map(r => r.price)).toEqual([undefined, undefined])
})


it.each(['light', 'normal', 'strong'] as const)('requires %s before enabling settings or a session, while allowing partial drafts', async tier => {
  const s = await stack({ adapter: new Adapter(false) })
  await s.ctx.modelRouter.command({ sessionId: 'parent', expectedRevision: 0, operationId: 'off-for-configuration', action: 'mode', mode: 'off' })
  for (const field of ['provider', 'model'] as const) {
    const incomplete = { provider: 'fixture', model: tier, [field]: '   ' }
    // Even an already-enabled settings owner cannot commit an incomplete slot.
    await expect(s.ctx.settings.mutate(NAMESPACE, [{ op: 'set', path: ['models', tier], value: incomplete }])).rejects.toThrow(tier)
    await s.ctx.settings.mutate(NAMESPACE, [{ op: 'set', path: ['enabled'], value: false }, { op: 'set', path: ['models', tier], value: incomplete }])
    await expect(s.ctx.settings.mutate(NAMESPACE, [{ op: 'set', path: ['enabled'], value: true }])).rejects.toThrow(tier)
    for (const mode of ['auto', 'fixed'] as const) {
      await expect(s.ctx.modelRouter.command({ sessionId: 'parent', expectedRevision: 1, operationId: `missing-${tier}-${field}-${mode}`, action: 'mode', mode, fixedModel: { provider: 'fixture', model: 'normal' } })).rejects.toThrow(tier)
    }
    expect((await s.ctx.modelRouter.describe('parent')).control).toMatchObject({ mode: 'off', revision: 1 })
    await s.ctx.settings.mutate(NAMESPACE, [{ op: 'set', path: ['models', tier], value: { provider: 'fixture', model: tier } }, { op: 'set', path: ['enabled'], value: true }])
  }
  const enabled = await s.ctx.modelRouter.command({ sessionId: 'parent', expectedRevision: 1, operationId: 'complete-configuration', action: 'mode', mode: 'auto' })
  expect(enabled.control.mode).toBe('auto')
})

it('allows the three roles to share a model and ignores obsolete duplicate backups', async () => {
  const s = await stack({ adapter: new Adapter(false) })
  const model = { provider: 'fixture', model: 'normal' }
  await s.ctx.settings.mutate(NAMESPACE, [
    { op: 'set', path: ['models'], value: { light: model, normal: model, strong: model } },
    { op: 'set', path: ['routing', 'fallbacks', 'normal'], value: [model, model] },
  ])
  await s.send()
  expect(s.adapter.calls.map(call => call.model)).toEqual(['normal'])
})


it('adds scoped coordination rules without replacing deployment instructions, and removes them on off/dispose', async () => {
  const s = await stack({ adapter: new Adapter(false) })
  s.ctx.systemPrompt.section({ name: 'fixture:preserved-policy', order: 0, text: 'Preserve user constraints.' })
  const assemble = () => s.ctx.systemPrompt.assemble(assembleContextFor(s.agent))
  const active = await assemble()
  expect(active.sections.find(v => v.name === 'enhanced-model-router:roles')?.text).toContain('Before any business tool, call model_router_task action decision')
  expect(active.sections.find(v => v.name === 'fixture:preserved-policy')?.text).toBe('Preserve user constraints.')
  expect(active.tools.some(t => t.name === TASK_TOOL)).toBe(true)
  await s.ctx.modelRouter.command({ sessionId: 'parent', action: 'mode', mode: 'off', expectedRevision: 0, operationId: 'off-policy' })
  const off = await assemble()
  expect(off.sections.find(v => v.name === 'enhanced-model-router:roles')?.text ?? '').toBe('')
  expect(off.tools.some(t => t.name === TASK_TOOL)).toBe(false)
  await s.fiber.dispose()
  expect((await assemble()).sections.some(v => v.name.startsWith('enhanced-model-router:'))).toBe(false)
})

it('keeps child instructions and task access scoped to their own role and execution', async () => {
  const s = await stack({ adapter: new Adapter(true, false, true) })
  const sending = s.send()
  await vi.waitFor(() => expect(s.ctx.agents.list().length).toBeGreaterThan(1))
  const child = s.ctx.agents.list().find(a => a.id !== s.agent.id)!
  const prompt = await child.ctx.systemPrompt.assemble(assembleContextFor(child))
  const policy = prompt.sections.find(v => v.name === 'enhanced-model-router:roles')?.text
  expect(policy).toMatch(/managed (search|expert) assistant/)
  expect(policy).not.toContain('NORMAL main coordinator')
  expect(prompt.tools.some(t => t.name === TASK_TOOL)).toBe(true)
  const signal = new AbortController().signal
  await expect(s.ctx.modelRouter.taskAction(child, { action: 'decision', strategy: 'delegate', workType: 'implementation', reason: 'escape child' }, signal)).rejects.toThrow('Only the main')
  await expect(s.ctx.modelRouter.taskAction(child, { action: 'inspect', taskId: 'foreign' }, signal)).rejects.toThrow('only their own')
  expect(JSON.parse(await s.ctx.modelRouter.taskAction(child, { action: 'inspect' }, signal)).taskId).toBeTruthy()
  s.agent.cancel({ kind: 'user' }); await sending
})

const reasoningReport = { summary: 'Answered the requested question.', changes: [], remaining: [], acceptance: [{ id: 'A1', condition: 'Answer the question', status: 'passed' as const, method: 'reasoning' as const, evidence: [], explanation: 'The supplied facts support this answer; no test execution is claimed.' }] }

it('detects file changes during a read-only child, including changes before its own final report', async () => {
  const s = await stack({ adapter: new Adapter(true, false, true) })
  await writeFile(resolve(s.root, 'fixture'), 'original')
  const sending = s.send()
  await vi.waitFor(async () => expect((await s.ctx.modelRouter.describe('parent')).run?.tasks.find(t => t.role === 'search')?.childSessionId).toBeTruthy())
  const before = (await s.ctx.modelRouter.describe('parent')).run!
  const task = before.tasks.find(t => t.role === 'search')!
  const child = s.ctx.agents.list().find(a => a.id === task.childSessionId)!
  await writeFile(resolve(s.root, 'fixture'), 'changed during inspection')
  await s.ctx.modelRouter.taskAction(child, { action: 'report', report: { ...reasoningReport, acceptance: [{ ...reasoningReport.acceptance[0]!, condition: task.acceptance[0]! }] } }, new AbortController().signal)
  s.agent.cancel({ kind: 'user' }); await sending
  const after = (await s.ctx.modelRouter.describe('parent')).run!.tasks.find(t => t.id === task.id)!
  expect(after.report).toBeDefined()
  expect(after.freshness).toBe('stale')
})

it('respects a deployment complete prompt instead of overriding its explicit ownership', async () => {
  const s = await stack({ adapter: new Adapter(false) })
  s.ctx.systemPrompt.section({ name: 'fixture:complete', order: 0, complete: true, text: 'Deployment owns this entire prompt.' })
  const prompt = await s.ctx.systemPrompt.assemble(assembleContextFor(s.agent))
  expect(prompt.sections).toEqual([{ name: 'fixture:complete', text: 'Deployment owns this entire prompt.' }])
})

it('pages actual evidence without discarding older facts or restarting work', async () => {
  const s = await stack({ adapter: new Adapter(false) }); await s.send()
  s.ctx.tools.register(defineTool({ name: 'read', description: 'Read fixture', parameters: {}, output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] }, execute: () => 'fixture evidence' }))
  const signal = new AbortController().signal
  for (let i = 0; i < 35; i++) await s.ctx.tools.execute({ agent: s.agent, name: 'read', callId: ToolCallId(`page-${i}`), arguments: {}, signal })
  await vi.waitFor(async () => expect((await s.ctx.modelRouter.describe('parent')).run!.evidence).toHaveLength(35))
  const first = JSON.parse(await s.ctx.modelRouter.taskAction(s.agent, { action: 'inspect' }, signal))
  const last = JSON.parse(await s.ctx.modelRouter.taskAction(s.agent, { action: 'inspect', offset: first.nextOffset }, signal))
  expect(first.evidence).toHaveLength(32); expect(last.evidence).toHaveLength(3)
  expect(last.nextOffset).toBeUndefined()
  expect(new Set([...first.evidence, ...last.evidence].map((e: { id: string }) => e.id)).size).toBe(35)
  expect(s.adapter.calls).toHaveLength(1)
})

it('records direct decisions and semantic acceptance without claiming a test, then invalidates them for followups', async () => {
  const s = await stack({ adapter: new Adapter(false) }); await s.send()
  const signal = new AbortController().signal
  const result = await s.ctx.tools.execute({ agent: s.agent, name: TASK_TOOL, callId: ToolCallId('record-decision'), arguments: { action: 'decision', strategy: 'direct', workType: 'answer', reason: 'A known factual answer needs no independent search.' }, signal })
  expect(result.isError).toBe(false)
  await s.ctx.modelRouter.taskAction(s.agent, { action: 'report', report: reasoningReport }, signal)
  const before = (await s.ctx.modelRouter.describe('parent')).run!
  expect(before.decision?.strategy).toBe('direct')
  expect(before.report?.acceptance[0]?.method).toBe('reasoning')
  expect(before.evidence ?? []).toHaveLength(0) // The management tool is not verification evidence.
  await s.send()
  expect((await s.ctx.modelRouter.describe('parent')).run?.report).toBeUndefined()
})

it('does not equate execution completion with acceptance or accept an unreviewed child as root success', async () => {
  const s = await stack(); await s.send()
  const run = (await s.ctx.modelRouter.describe('parent')).run!
  expect(run.status).toBe('completed')
  expect(run.report).toBeUndefined()
  expect(run.tasks.every(t => !t.report)).toBe(true)
  await expect(s.ctx.modelRouter.taskAction(s.agent, { action: 'report', report: reasoningReport }, new AbortController().signal)).rejects.toThrow('Review every child')
  const child = run.tasks[0]!
  await expect(s.ctx.modelRouter.taskAction(s.agent, { action: 'report', taskId: child.id, executionId: 'old', report: reasoningReport }, new AbortController().signal)).rejects.toThrow('current child executionId')
})

it('marks read-only results stale and requires fresh main evidence before accepting the changed files', async () => {
  const s = await stack(); await s.send()
  const task = (await s.ctx.modelRouter.describe('parent')).run!.tasks.find(t => t.role === 'search')!
  expect(task.freshness).toBe('current')
  await writeFile(resolve(s.root, 'fixture'), 'new source state')
  expect((await s.ctx.modelRouter.describe('parent')).run!.tasks.find(t => t.id === task.id)?.freshness).toBe('stale')
  const report = { ...reasoningReport, acceptance: [{ ...reasoningReport.acceptance[0]!, condition: task.acceptance[0]! }] }
  const request = { action: 'report' as const, taskId: task.id, executionId: task.executionId, report }
  const signal = new AbortController().signal
  await expect(s.ctx.modelRouter.taskAction(s.agent, request, signal)).rejects.toThrow('Recheck the current files')
  s.ctx.tools.register(defineTool({ name: 'read', description: 'read actual changed file', parameters: {}, output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] }, execute: () => readFile(resolve(s.root, 'fixture'), 'utf8') }))
  const read = await s.ctx.tools.execute({ agent: s.agent, name: 'read', callId: ToolCallId('fresh-source-read'), arguments: {}, signal })
  expect(read.isError).toBe(false)
  await vi.waitFor(async () => expect((await s.ctx.modelRouter.describe('parent')).run!.evidence?.length).toBe(1))
  await s.ctx.modelRouter.taskAction(s.agent, { ...request, report: { ...report, acceptance: [{ ...report.acceptance[0]!, method: 'tool', evidence: ['fresh-source-read'] }] } }, signal)
  const reviewed = (await s.ctx.modelRouter.describe('parent')).run!.tasks.find(t => t.id === task.id)!
  expect(reviewed.freshness).toBe('current')
  expect(reviewed.report?.reviewedBy).toBe(s.agent.id)
})

it('imports V3 and V4 read-only into V5 while keeping old writer domains unchanged', async () => {
  const s = await stack({ adapter: new Adapter(false) }); await s.send()
  const run = structuredClone((await s.ctx.modelRouter.describe('parent')).run!)
  await s.fiber.dispose()
  const legacy = await s.ctx.storageDomain.open(v3DomainSpec)
  const previousV3 = { ...run, id: 'legacy-v3-audit' }
  await legacy.table('runs').put('legacy-v3-audit', previousV3)
  const oldV3 = structuredClone(legacy.table('runs').get('legacy-v3-audit')); await legacy.close()
  const previousV4 = { ...run, id: 'legacy-v4-audit' }
  const v4 = await s.ctx.storageDomain.open(v4DomainSpec)
  await v4.table('runs').put('legacy-v4-audit', previousV4)
  const oldV4 = structuredClone(v4.table('runs').get('legacy-v4-audit')); await v4.close()
  const current = await s.ctx.storageDomain.open(domainSpec)
  await current.global.set({ migrated: false }); await current.close()
  const fiber = await s.ctx.plugin(Router, Router.Config({ enabled: true, models: run.config.models }))
  await fiber.dispose()
  const migrated = await s.ctx.storageDomain.open(domainSpec)
  const reread = await s.ctx.storageDomain.open(v3DomainSpec)
  expect(migrated.table('runs').get('legacy-v3-audit')?.id).toBe('legacy-v3-audit')
  expect(migrated.table('runs').get('legacy-v4-audit')?.id).toBe('legacy-v4-audit')
  expect(reread.table('runs').get('legacy-v3-audit')).toEqual(oldV3)
  const rereadV4 = await s.ctx.storageDomain.open(v4DomainSpec)
  expect(rereadV4.table('runs').get('legacy-v4-audit')).toEqual(oldV4)
  await migrated.close(); await reread.close()
  await rereadV4.close()
})


it('runs decision, child reporting, main acceptance and final reporting through actual tool dispatch', async () => {
  let current: Awaited<ReturnType<typeof stack>>
  class ReportingAdapter extends Adapter {
    steps = new Map<string, number>()
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const main = options.tools?.some(t => t.name === DELEGATE_TOOL)
      const identity = options.sessionId ?? options.model
      const step = this.steps.get(identity) ?? 0; this.steps.set(identity, step + 1)
      let name: string | undefined; let args: Record<string, unknown> = {}
      const report = { ...reasoningReport, acceptance: [{ ...reasoningReport.acceptance[0]!, condition: 'Report evidence', method: 'tool', evidence: ['read-workflow'] }] }
      if (main && step === 0) { name = TASK_TOOL; args = { action: 'decision', strategy: 'delegate', workType: 'research', reason: 'Locate the actual file with a bounded search.' } }
      if (main && step === 1) { name = DELEGATE_TOOL; args = input('search') }
      if (!main && step === 0) {
        expect(JSON.stringify(options.messages)).toContain('managed search assistant')
        expect(options.tools?.some(t => t.name === TASK_TOOL)).toBe(true)
        name = 'read'
      }
      if (!main && step === 1) { name = TASK_TOOL; args = { action: 'report', report } }
      if (main && step === 2) {
        const task = (await current.ctx.modelRouter.describe('parent')).run!.tasks[0]!
        expect(task.report?.acceptance[0]?.status).toBe('passed')
        name = TASK_TOOL; args = { action: 'report', taskId: task.id, executionId: task.executionId, report }
      }
      if (main && step === 3) { name = TASK_TOOL; args = { action: 'report', report: reasoningReport } }
      if (name) {
        const id = name === 'read' ? 'read-workflow' : `workflow-${identity}-${step}`
        yield { type: 'block-start', index: 0, blockType: 'tool-call', toolCallId: id, toolName: name }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Reported the verified outcome.' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  current = await stack({ adapter: new ReportingAdapter() })
  const failures: unknown[] = []
  current.ctx.on('tools/result', (exec, result) => { if (result.isError) failures.push({ tool: exec.name, result }) })
  await writeFile(resolve(current.root, 'fixture'), 'Real fixture evidence')
  current.ctx.tools.register(defineTool({ name: 'read', description: 'Read fixture file', parameters: {}, output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] }, execute: () => readFile(resolve(current.root, 'fixture'), 'utf8') }))
  await current.send()
  expect(failures).toEqual([])
  const run = (await current.ctx.modelRouter.describe('parent')).run!
  expect(run.tasks).toHaveLength(1)
  expect(run.tasks[0]!.report?.reviewedBy).toBe('parent')
  expect(run.report?.acceptance[0]?.status).toBe('passed')
  expect(run.status).toBe('completed')
})
