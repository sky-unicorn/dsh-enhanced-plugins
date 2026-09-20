/** Real, keyless agent/tool/child runs for the assembled Web verification. */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
export const inject = ['agents', 'subagents', 'sessions', 'sessionPersistence', 'llm', 'tools', 'sessionTitle']
export async function apply(ctx, config) {
  const require = createRequire(ctx.baseUrl)
  const { LlmAdapter, createUserMessage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href)
  const { defineTool } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')).href)
  class Adapter extends LlmAdapter {
    async *stream(options) {
      const input = options.messages.filter(item => item.source?.kind === 'user').flatMap(item => item.content).filter(item => item.type === 'text').map(item => item.text).join('\n')
      if (!options.messages.some(item => item.source?.kind === 'tool')) {
        const args = JSON.stringify({ task: input })
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: 'execution-fixture-call', name: 'inspect_fixture', argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'execution-fixture-call', name: 'inspect_fixture', arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Execution fixture completed.' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Execution fixture completed.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['execution-fixture'], new Adapter())
  ctx.tools.register(defineTool({ name: 'inspect_fixture', description: 'Read a controlled fixture', parameters: { task: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      if (args.task.includes('FAIL')) throw new Error('Fixture tool failure')
      if (args.task.includes('HOLD')) while (!existsSync(join(config.cwd, 'release'))) await pause(100, undefined, { signal: exec.signal })
      return 'Inspected app.ts successfully.'
    },
  }))
  const handle = await ctx.agents.create({ sessionId: 'execution-monitor-parent', meta: { cwd: config.cwd }, agentOptions: { provider: 'execution-fixture', model: 'fixture' } })
  const runs = []
  ctx.effect(() => async () => { for (const run of runs.reverse()) await run.dispose(); await handle.dispose() })
  const parent = handle.agent
  ctx.sessionTitle.rename(parent.session, 'Execution monitor fixture')
  parent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect the execution flow.' }] }))
  await parent.whenIdle()
  const start = async (owner, label, prompt, hold = false) => {
    const run = await ctx.subagents.start('spawn', { parent: owner, label, prompt: [{ type: 'text', text: prompt }], signal: new AbortController().signal })
    runs.push(run)
    if (!hold) { await run.result; await run.dispose() }
    return run
  }
  const finished = await start(parent, 'Researcher', 'Inspect references.')
  const continuation = await ctx.subagents.startContinuable({ provider: 'spawn', label: 'Developer',
    request: { parent, prompt: [{ type: 'text', text: 'HOLD while inspecting app.ts' }] }, signal: new AbortController().signal })
  const running = { id: continuation.childId }
  const owner = ctx.agents.get(running.id)
  if (!owner) throw new Error('Expected a running child')
  await ctx.subagents.sendMessage(owner, parent.id, [{ type: 'text', text: 'Progress: inspecting app.ts; waiting for the controlled check.' }], { signal: new AbortController().signal })
  const nested = await start(owner, 'Reviewer', 'Inspect nested execution.')
  const failed = await start(parent, 'Tester', 'FAIL the fixture inspection.')
  await ctx.sessionPersistence.flush()
  writeFileSync(join(config.cwd, 'seed.json'), JSON.stringify({ parent: parent.id, running: running.id, finished: finished.id, failed: failed.id, nested: nested.id }))
}
