import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-subagent'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { describeMonitor, type CatalogReads } from './catalog.js'
import { teamProjectionState } from './snapshot.js'
import type { MonitorSnapshot } from '../shared.js'

export const name = 'agent-team-monitor'
export const inject = ['agents', 'sessions']

/** Read-only adapter. Agent Teams and persistence are optional, queried per request for HMR. */
export class AgentTeamMonitorRemote extends TypertRemoteService {
  private readonly reads: CatalogReads
  private readonly lifetime = new AbortController()

  constructor(ctx: Context) {
    super(ctx, 'agentTeamMonitor')
    ctx.effect(() => () => this.lifetime.abort(), 'team monitor: cancel outstanding reads')
    this.reads = {
      agent: id => ctx.agents.get(id),
      descendants: async (id, signal) => ctx.get('subagents')?.listDescendants(id, signal),
      teamService: agent => agent?.ctx.get('agentTeams') ?? ctx.get('agentTeams'),
      inspect: async (id, signal) => {
        const live = ctx.sessions.get(id)
        if (live !== undefined) {
          return {
            meta: live.header,
            inheritedEventCount: live.inheritedEventCount,
            events: live.snapshotEvents(),
          }
        }
        const persistence = ctx.get('sessionPersistence')
        if (persistence === undefined) throw new Error('session persistence unavailable')
        // inspect(), unlike load()/prepare(), never commits recovery or publishes an Agent.
        return persistence.inspect(id, signal)
      },
      project: (meta, inheritedEventCount, events) => {
        // The Team runtime owns and registers this host-only projection. The
        // public registry folds the cold log without publishing a Session or
        // activating an Agent; an absent runtime means the capability is absent.
        const projections = ctx.get('sessionProjections')
        if (projections === undefined) return undefined
        const row = projections.restore(
          {},
          events,
          SessionLogOffset(0),
          meta,
          inheritedEventCount,
        ).checkpoint.agentTeam
        return teamProjectionState(row?.val)
      },
    }
    // Source-mode Typert marker, preserving Node 22 compatibility (no native decorators).
    Remote('describe')(this.describe, {
      name: 'describe', static: false, private: false,
      addInitializer: initializer => initializer.call(this),
    } as ClassMethodDecoratorContext<AgentTeamMonitorRemote, typeof this.describe>)
  }

  /** Inspect one selected root/roster child. This method cannot mutate or activate a Team. */
  async describe(request: unknown, signal: AbortSignal): Promise<MonitorSnapshot> {
    if (request === null || typeof request !== 'object' || Array.isArray(request)
      || !('sessionId' in request) || typeof request.sessionId !== 'string'
      || request.sessionId.length === 0 || request.sessionId.length > 512) {
      throw new TypeError('agentTeamMonitor/describe: invalid sessionId')
    }
    return describeMonitor(this.reads, SessionId(request.sessionId), AbortSignal.any([signal, this.lifetime.signal]))
  }
}

/** Register only the observer; deliberately does not enable the experimental runtime or model tools. */
export function apply(ctx: Context): void { new AgentTeamMonitorRemote(ctx) }
