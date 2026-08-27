/** Keyless real workflow fixture; gates and all sessions live only in the supplied test workspace. */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'

export const name = 'workflow-monitor-web-fixture'
export const inject = ['agents', 'sessions', 'sessionPersistence', 'workflowEngine', 'workspaceRegistry', 'llm', 'sessionTitle']

export async function apply(ctx, config) {
  const require = createRequire(ctx.baseUrl)
  const { LlmAdapter, createUserMessage, CallId } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href)
  const script = `
await agent('ARCHITECT_FIXTURE', { label: '整体架构师', phase: '1-总体架构设计', provider: 'workflow-monitor-fixture', model: 'keyless-fixture' });
await agent('IMPLEMENTER_FIXTURE', { label: '前端工程师', phase: '2-Web 实现', provider: 'workflow-monitor-fixture', model: 'keyless-fixture' });
return { done: true };`
  class FixtureAdapter extends LlmAdapter {
    dispatched = false
    async *stream(options) {
      const direct = options.messages.filter(message => message.role === 'user')
        .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n')
      if (direct.includes('RUN_WORKFLOW_FIXTURE') && !this.dispatched) {
        this.dispatched = true
        const args = JSON.stringify({ script, meta: { name: 'gomoku-team-build', description: 'Isolated two-member workflow validation' } })
        const id = CallId('workflow-monitor-call')
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: 'workflow', argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'workflow', arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const gate = direct.includes('ARCHITECT_FIXTURE') ? 'release-architect' : direct.includes('IMPLEMENTER_FIXTURE') ? 'release-implementer' : undefined
      const text = gate === undefined ? 'Fixture conversation complete.' : 'Working in the isolated workflow fixture.'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      if (gate !== undefined) {
        for (;;) {
          options.signal.throwIfAborted()
          try { await access(join(config.cwd, `${gate}-v3`)); break } catch (error) { if (error.code !== 'ENOENT') throw error }
          await pause(200, undefined, { signal: options.signal })
        }
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['workflow-monitor-fixture'], new FixtureAdapter())
  if ((await ctx.sessionPersistence.list()).some(header => header.id === 'workflow-monitor-parent-v3')) return
  const workspace = await ctx.workspaceRegistry.create(config.cwd, 'Workflow monitor verification')
  const handles = []
  ctx.effect(() => async () => { for (const handle of handles.reverse()) await handle.dispose() }, 'workflow fixture: dispose owned agents')
  for (const [id, title, prompt] of [
    ['workflow-monitor-ordinary-v3', '普通对话 — 无团队入口', 'Plain fixture conversation.'],
    ['workflow-monitor-parent-v3', '工作流团队 — 会话内监控验证', 'RUN_WORKFLOW_FIXTURE'],
  ]) {
    const handle = await ctx.agents.create({ sessionId: id, meta: { cwd: workspace.path }, agentOptions: { provider: 'workflow-monitor-fixture', model: 'keyless-fixture' } })
    handles.push(handle)
    await workspace.attachSession(handle.agent.id)
    ctx.sessionTitle.rename(handle.agent.session, title)
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] }))
    if (id.includes('ordinary')) await handle.agent.whenIdle()
  }
}
