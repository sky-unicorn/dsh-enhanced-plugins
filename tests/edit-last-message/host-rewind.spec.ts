import { describe, expect, it } from 'vitest'
import { rewriteLastMessage } from '../../src/edit-last-message/host/rewind.ts'
import { editLastMessageSource } from '../../src/edit-last-message/shared.ts'

interface FakeEvent {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
  surfaceOp?: unknown
  sourceEventSeqs?: number[]
}

class FakeSession {
  readonly events: FakeEvent[] = []
  readonly surface = { nodes: [] as number[] }
  readonly header = { id: 'session-1' }

  eventAt(seq: number): FakeEvent | undefined {
    return this.events[seq]
  }

  append(type: string, data: Record<string, unknown>, options?: {
    surfaceOp: 'append' | { op: 'replace'; start: number; end: number }
    sourceEventSeqs?: number[]
  }): FakeEvent {
    const event: FakeEvent = {
      type,
      seq: this.events.length,
      time: this.events.length + 1,
      data,
      ...(options === undefined ? {} : {
        surfaceOp: options.surfaceOp,
        ...(options.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: options.sourceEventSeqs }),
      }),
    }
    this.events.push(event)
    if (options?.surfaceOp === 'append') this.surface.nodes.push(event.seq)
    else if (options?.surfaceOp !== undefined) {
      const start = this.surface.nodes.indexOf(options.surfaceOp.start)
      const end = this.surface.nodes.indexOf(options.surfaceOp.end)
      this.surface.nodes.splice(start, end - start + 1, event.seq)
    }
    return event
  }
}

function originalSession(): FakeSession {
  const session = new FakeSession()
  session.append('user/message', {
    id: 'original-message', role: 'user', content: [{ type: 'text', text: 'old' }], source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1, step: 1,
    message: { id: 'old-answer', role: 'assistant', content: [{ type: 'text', text: 'old answer' }], source: { kind: 'model' } },
  }, { surfaceOp: 'append' })
  return session
}

function agentFor(session: FakeSession, beforeEditedMessage?: () => void) {
  const queued: Record<string, unknown>[] = []
  const inbox = { nextTurn: [] as Record<string, unknown>[], nextStep: [] as Record<string, unknown>[] }
  return {
    status: 'idle',
    session,
    inbox,
    followup(message: Record<string, unknown>) {
      queued.push(message)
      inbox.nextTurn.push(message)
      session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
    },
    async runMaintenance(job: (signal: AbortSignal) => Promise<void>) {
      await job(new AbortController().signal)
      const message = queued.shift()
      if (message === undefined) return
      inbox.nextTurn.shift()
      session.append('turn/start', { turn: 2 })
      session.append('step/start', { turn: 2, step: 1 })
      beforeEditedMessage?.()
      session.append('user/message', message, { surfaceOp: 'append' })
    },
    async whenIdle() {},
  }
}

describe('rewriteLastMessage', () => {
  it('keeps one session and replaces the current model surface tail', async () => {
    const session = originalSession()
    const result = await rewriteLastMessage(agentFor(session) as never, { messageSeq: 0, text: 'revised' })

    expect(result).toEqual({ accepted: true, replacementSeq: 5 })
    expect(session.events.slice(0, 2).map(event => event.data)).toEqual([
      expect.objectContaining({ id: 'original-message' }),
      expect.objectContaining({ message: expect.objectContaining({ id: 'old-answer' }) }),
    ])
    expect(session.surface.nodes).toEqual([5])
    expect(session.events[5]).toMatchObject({
      type: 'user/message',
      surfaceOp: { op: 'replace', start: 0, end: 1 },
      sourceEventSeqs: [0, 1],
      data: { content: [{ type: 'text', text: 'revised' }] },
    })
  })

  it('preserves the original bubble identity across repeated edits', async () => {
    const session = originalSession()
    await rewriteLastMessage(agentFor(session) as never, { messageSeq: 0, text: 'first revision' })
    session.append('assistant/message', {
      turn: 2, step: 1,
      message: { id: 'new-answer', role: 'assistant', content: [{ type: 'text', text: 'new answer' }], source: { kind: 'model' } },
    }, { surfaceOp: 'append' })
    const firstReplacement = session.surface.nodes[0]!

    const second = await rewriteLastMessage(
      agentFor(session) as never,
      { messageSeq: firstReplacement, text: 'second revision' },
    )
    const source = editLastMessageSource(session.events[second.replacementSeq]?.data['source'])
    expect(source?.editLastMessage).toEqual({ version: 1, rootSeq: 0, rootMessageId: 'original-message' })
    expect(session.surface.nodes).toEqual([second.replacementSeq])
  })

  it('keeps context injected for the regenerated turn outside the old tail', async () => {
    const session = originalSession()
    const agent = agentFor(session, () => {
      session.append('user/message', {
        id: 'fresh-context',
        role: 'user',
        content: [{ type: 'text', text: 'fresh runtime context' }],
        source: { kind: 'plugin', plugin: 'runtime-context' },
      }, { surfaceOp: 'append' })
    })

    const result = await rewriteLastMessage(agent as never, { messageSeq: 0, text: 'revised' })

    expect(session.surface.nodes).toEqual([result.replacementSeq, 5])
    expect(session.events[result.replacementSeq]).toMatchObject({
      surfaceOp: { op: 'replace', start: 0, end: 1 },
      sourceEventSeqs: [0, 1],
    })
    expect(session.events[5]?.data).toMatchObject({ id: 'fresh-context' })
  })

  it('rejects running, stale, and queued edits before installing an interception', async () => {
    const runningSession = originalSession()
    const running = agentFor(runningSession)
    running.status = 'running'
    await expect(rewriteLastMessage(running as never, { messageSeq: 0, text: 'x' })).rejects.toThrow('still running')

    const staleSession = originalSession()
    staleSession.append('user/message', {
      id: 'later', role: 'user', content: [{ type: 'text', text: 'later' }], source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    await expect(rewriteLastMessage(agentFor(staleSession) as never, { messageSeq: 0, text: 'x' }))
      .rejects.toThrow('no longer the latest')

    const queuedSession = originalSession()
    const queued = agentFor(queuedSession)
    queued.inbox.nextTurn.push({ id: 'queued' })
    await expect(rewriteLastMessage(queued as never, { messageSeq: 0, text: 'x' }))
      .rejects.toThrow('queued user messages')
  })
})
