/** Real native child sessions for role/history navigation QA; no network or model credentials. */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'

export const name = 'roles-monitor-web-fixture'
export const inject = ['agents', 'subagents', 'sessions', 'sessionPersistence', 'workspaceRegistry', 'llm', 'sessionTitle']

export async function apply(ctx, config) {
  const require = createRequire(ctx.baseUrl)
  const { LlmAdapter, createUserMessage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href)
  class FixtureAdapter extends LlmAdapter {
    async *stream(options) {
      const text = options.messages.filter(message => message.role === 'user').flatMap(message => message.content)
        .filter(block => block.type === 'text').map(block => block.text).join('\n')
      if (text.includes('FAIL_ROLE_FIXTURE')) throw new Error('Controlled role fixture failure')
      const output = text.includes('HOLD_ROLE_FIXTURE') ? '架构师正在执行第二次设计检查。' : '本次执行已完成，可从角色历史中打开这份会话。'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: output }
      if (text.includes('HOLD_ROLE_FIXTURE')) for (;;) {
        options.signal.throwIfAborted()
        try { await access(join(config.cwd, 'release-role-running')); break } catch (error) { if (error.code !== 'ENOENT') throw error }
        await pause(200, undefined, { signal: options.signal })
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: output } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['role-monitor-fixture'], new FixtureAdapter())
  if ((await ctx.sessionPersistence.list()).some(header => header.id === 'role-monitor-parent-v1')) return
  const workspace = await ctx.workspaceRegistry.create(config.cwd, '角色与子会话验证')
  const handles = []
  const runs = []
  ctx.effect(() => async () => {
    for (const run of runs.reverse()) await run.dispose()
    for (const handle of handles.reverse()) await handle.dispose()
  }, 'role fixture: own child runs and parents')
  const createParent = async (id, title) => {
    const handle = await ctx.agents.create({ sessionId: id, meta: { cwd: workspace.path }, agentOptions: { provider: 'role-monitor-fixture', model: 'keyless-fixture' } })
    handles.push(handle)
    await workspace.attachSession(id)
    ctx.sessionTitle.rename(handle.agent.session, title)
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '验证当前会话内的角色与执行历史。' }] }))
    await handle.agent.whenIdle()
    return handle.agent
  }
  await createParent('role-monitor-ordinary-v1', '普通对话 — 无子代理')
  const parent = await createParent('role-monitor-parent-v1', '角色执行记录 — 原生会话详情')
  const start = async (owner, label, title, prompt, hold = false) => {
    const run = await ctx.subagents.start('spawn', { parent: owner, ...(label === undefined ? {} : { label }), prompt: [{ type: 'text', text: prompt }], signal: new AbortController().signal })
    runs.push(run)
    const session = ctx.sessions.get(run.id)
    if (session !== undefined) ctx.sessionTitle.rename(session, title)
    if (!hold) { await run.result; await run.dispose() }
    return run
  }
  await start(parent, '整体架构师', '架构设计 · 第一次执行', 'Complete the initial architecture.')
  const active = await start(parent, '整体架构师', '架构设计 · 第二次执行', 'HOLD_ROLE_FIXTURE', true)
  const child = ctx.agents.get(active.id)
  if (child === undefined) throw new Error('Expected live role fixture child')
  await start(child, '测试工程师', '架构验证 · 嵌套会话', 'Validate the architecture.')
  await start(parent, '测试工程师', '测试检查 · 失败记录', 'FAIL_ROLE_FIXTURE')
  await start(parent, undefined, '未标注角色 · 会话记录', 'Complete an unlabelled task.')
}
