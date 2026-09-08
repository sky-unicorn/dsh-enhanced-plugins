import type { Context } from '@deepseek-ai/cordis'
import { EditLastMessageRemote } from './remote.js'
import { installEditAdmission } from './rewind.js'
import type { Agent } from '@deepseek-ai/dsh-agent'

export const name = 'edit-last-message-host'
export const inject = ['agents']

/** Install the same-session edit Remote without changing DSH core. */
export function apply(ctx: Context): void {
  const admissions = new Map<Agent, () => void>()
  const install = (agent: Agent): void => {
    if (!admissions.has(agent)) admissions.set(agent, installEditAdmission(agent.session))
  }
  ctx.on('agent/created', ({ agent }) => install(agent))
  ctx.on('agent/disposed', ({ agent }) => {
    admissions.get(agent)?.()
    admissions.delete(agent)
  })
  for (const agent of ctx.agents.list()) install(agent)
  const remote = new EditLastMessageRemote(ctx)
  ctx.effect(() => async () => {
    await remote.settle()
    for (const dispose of admissions.values()) dispose()
    admissions.clear()
  }, 'edit-last-message: durable edit admission')
}

export { EditLastMessageRemote } from './remote.js'
export { rewriteLastMessage } from './rewind.js'
export type { EditLastMessageHostRequest, EditLastMessageHostResult } from './rewind.js'
