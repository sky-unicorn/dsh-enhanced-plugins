/** Keyless fixture for a real DSH Web profile. All Agents/tasks are owned by official services. */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export const name = 'team-monitor-web-fixture'
export const inject = ['agentLoop', 'agents', 'sessions', 'sessionPersistence', 'agentTeams', 'subagents', 'workspaceRegistry', 'llm', 'sessionTitle']

export async function apply(ctx, config) {
  const require = createRequire(ctx.baseUrl)
  const { LlmAdapter, createUserMessage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href)
  class FixtureAdapter extends LlmAdapter {
    async *stream(options) {
      const hold = options.messages.some(message => message.content.some(block => block.type === 'text' && block.text.includes('HOLD_FIXTURE')))
      const text = hold ? 'Implementation is running in the isolated monitor fixture.' : 'The public ABI inspection is complete.'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      if (hold) await new Promise((resolve, reject) => {
        if (options.signal.aborted) { reject(options.signal.reason); return }
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      })
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['monitor-fixture'], new FixtureAdapter())
  const persisted = await ctx.sessionPersistence.list()
  if (persisted.some(header => header.id === 'monitor-web-lead-v2')) return
  const workspace = await ctx.workspaceRegistry.create(config.cwd, 'Team monitor verification')
  const { agent: lead } = await ctx.agents.create({ sessionId: 'monitor-web-lead-v2', meta: { cwd: workspace.path }, agentOptions: { provider: 'monitor-fixture', model: 'keyless-fixture' } })
  await workspace.attachSession(lead.id)
  ctx.sessionTitle.rename(lead.session, 'Official Team Monitor — live fixture')
  lead.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Use official Agent Teams to inspect, implement and review the monitor.' }] }))
  await lead.whenIdle()
  for (const [name, description, prompt] of [
    ['researcher', 'Inspect official services and public contracts', 'Inspect the official ABI.'],
    ['implementer', 'Build the read-only Host and Web Client', 'HOLD_FIXTURE'],
    ['reviewer', 'Review lifecycle and packaging', 'Review the published contracts.'],
  ]) {
    await ctx.agentTeams.spawnTeammate(lead, { name, description, prompt: [{ type: 'text', text: prompt }], context: 'fresh', provider: 'spawn', signal: new AbortController().signal })
  }
  const create = (subject, description, blockedBy = [], writeScopes = []) => ctx.agentTeams.createTask(lead, { subject, description, blockedBy, writeScopes })
  const research = await create('Inspect public ABI', 'Validate TeamService and persistence contracts.', [], ['docs'])
  const claimed = await ctx.agentTeams.updateTask(lead, { taskId: research.id, expectedRevision: research.revision, action: 'reassign', owner: 'researcher' })
  await ctx.agentTeams.updateTask(lead, { taskId: research.id, expectedRevision: claimed.revision, action: 'complete' })
  const implementation = await create('Build read-only monitor', 'Implement the observer and dependency graph without changing DSH core.', [research.id], ['src'])
  await ctx.agentTeams.updateTask(lead, { taskId: implementation.id, expectedRevision: implementation.revision, action: 'reassign', owner: 'implementer' })
  await create('Verify lifecycle', 'Check cancellation, session switching and historical replay.', [implementation.id], ['tests'])
  await create('Review Web panel', 'Review accessibility and light/dark themes.', [implementation.id], ['src/client'])
  await create('Write usage notes', 'Document observer-only semantics and installation.', [], ['README.md'])
  await ctx.agentTeams.sendMessage(lead, { target: 'reviewer', delivery: 'quiet', content: [{ type: 'text', text: 'PRIVATE_FIXTURE_MAIL_NOT_FOR_MONITOR_WIRE' }], signal: new AbortController().signal })
  const { agent: plain } = await ctx.agents.create({ sessionId: 'monitor-ordinary-session', meta: { cwd: workspace.path }, agentOptions: { provider: 'monitor-fixture', model: 'keyless-fixture' } })
  ctx.sessionTitle.rename(plain.session, 'Ordinary conversation — no Team')
  await workspace.attachSession(plain.id)
}
