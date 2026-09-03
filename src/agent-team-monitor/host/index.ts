import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-subagent'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { describeMonitor, type CatalogReads } from './catalog.js'
import { teamProjectionState } from './snapshot.js'
import type { MonitorSnapshot } from '../shared.js'

export const name = 'agent-team-monitor'
export const inject = ['agents', 'sessions']

/** Read-only adapter. Agent Teams and session queries are optional, queried per request for HMR. */
export class AgentTeamMonitorRemote extends TypertRemoteService {
  private readonly reads: CatalogReads
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<MonitorSnapshot>>()

  constructor(ctx: Context) {
    super(ctx, 'agentTeamMonitor')
    ctx.effect(() => async () => {
      this.lifetime.abort()
      await Promise.allSettled(this.pending)
    }, 'team monitor: cancel and release outstanding reads')
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
        const query = ctx.get('sessionQuery')
        if (query === undefined) throw new Error('session query unavailable')
        // The public observation API reads history without activation. The query
        // owner handles persistence access and balances interrupted logs in memory.
        const observation = await query.observeSession(id, { signal, projectionMode: 'none' })
        try {
          signal.throwIfAborted()
          return {
            meta: observation.header,
            inheritedEventCount: observation.inheritedEventCount,
            events: observation.events,
          }
        } finally {
          observation[Symbol.dispose]()
        }
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
    const pending = describeMonitor(this.reads, SessionId(request.sessionId), AbortSignal.any([signal, this.lifetime.signal]))
    this.pending.add(pending)
    try {
      return await pending
    } finally {
      this.pending.delete(pending)
    }
  }
}

/** Register only the observer; deliberately does not enable the experimental runtime or model tools. */
export function apply(ctx: Context): void { new AgentTeamMonitorRemote(ctx) }
