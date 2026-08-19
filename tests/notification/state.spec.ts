import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import { describe, expect, it, vi } from 'vitest'
import { Config } from '../../src/notification/host/config.ts'
import { NotificationConfigRemote } from '../../src/notification/host/remote.ts'
import { NotificationStateTracker } from '../../src/notification/host/state.ts'
import { DEFAULT_NOTIFICATION_SETTINGS } from '../../src/notification/shared.ts'

function session(id: string, origin?: 'subagent', events: SessionEvent[] = []): Session {
  return {
    id,
    header: { ...(origin === undefined ? {} : { origin }) },
    events,
  } as unknown as Session
}

function event(type: string, data: Record<string, unknown>, seq = 0): SessionEvent {
  return { type, data, seq, time: seq } as unknown as SessionEvent
}

describe('desktop notification state', () => {
  it('prioritizes human confirmation over working and returns to idle on completion', () => {
    const tracker = new NotificationStateTracker()
    const root = session('root')
    expect(tracker.initialize([root])).toBe('idle')

    expect(tracker.consume(root, event('turn/start', { turn: 1 }))).toEqual({
      state: 'working', confirmation: false, completion: false,
    })
    expect(tracker.consume(root, event('tool/call', {
      turn: 1, step: 1, callId: 'question-1', name: 'ask_user_question', arguments: '{}',
    }, 1))).toEqual({ state: 'confirmation', confirmation: true, completion: false })
    expect(tracker.consume(root, event('tool/result', {
      turn: 1, step: 1, message: { role: 'tool', toolCallId: 'question-1', content: [] },
    }, 2))).toEqual({ state: 'working', confirmation: false, completion: false })
    expect(tracker.consume(root, event('approval/asked', { id: 'approval-1', toolName: 'bash' }, 3)))
      .toEqual({ state: 'confirmation', confirmation: true, completion: false })
    expect(tracker.consume(root, event('approval/decided', { id: 'approval-1', outcome: 'allowed-once' }, 4)))
      .toEqual({ state: 'working', confirmation: false, completion: false })
    expect(tracker.consume(root, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5)))
      .toEqual({ state: 'idle', confirmation: false, completion: true })
  })

  it('folds concurrent sessions globally and never chimes for a subagent turn', () => {
    const tracker = new NotificationStateTracker()
    const root = session('root')
    const child = session('child', 'subagent')
    tracker.initialize([root, child])
    tracker.consume(root, event('turn/start', { turn: 1 }))
    tracker.consume(child, event('turn/start', { turn: 1 }))

    expect(tracker.consume(root, event('turn/end', { turn: 1, reason: { kind: 'completed' } })))
      .toEqual({ state: 'working', confirmation: false, completion: true })
    expect(tracker.consume(child, event('turn/end', { turn: 1, reason: { kind: 'completed' } })))
      .toEqual({ state: 'idle', confirmation: false, completion: false })
  })

  it('reconstructs pending state silently and removes disposed sessions', () => {
    const seeded = session('seeded', undefined, [
      event('turn/start', { turn: 1 }),
      event('approval/asked', { id: 'approval-1', toolName: 'bash' }, 1),
    ])
    const tracker = new NotificationStateTracker()
    expect(tracker.initialize([seeded])).toBe('confirmation')
    expect(tracker.remove(seeded)).toBe('idle')
  })

  it('treats plan review as a confirmation wait until its tool settles', () => {
    const tracker = new NotificationStateTracker()
    const root = session('plan')
    tracker.initialize([root])
    tracker.consume(root, event('turn/start', { turn: 1 }))
    expect(tracker.consume(root, event('tool/call', {
      turn: 1, step: 1, callId: 'plan-1', name: 'exit_plan_mode', arguments: '{}',
    }))).toEqual({ state: 'confirmation', confirmation: true, completion: false })
    expect(tracker.consume(root, event('tool/result', {
      turn: 1, step: 1, message: { role: 'tool', toolCallId: 'plan-1', content: [] },
    }))).toEqual({ state: 'working', confirmation: false, completion: false })
  })
})

describe('desktop notification assets and defaults', () => {
  it('resolves the complete schema defaults', () => {
    expect(Config({})).toEqual(DEFAULT_NOTIFICATION_SETTINGS)
    expect(() => Config({ petSize: 20 })).toThrow()
    expect(() => Config({ completionSound: 'unknown' })).toThrow()
  })

  it('ships a topmost WPF companion and the official fish vector', async () => {
    const script = await readFile(resolve(import.meta.dirname, '../../assets/notification/desktop-pet.ps1'), 'utf8')
    const icon = await readFile(resolve(import.meta.dirname, '../../assets/notification/deepseek-fish.svg'), 'utf8')
    expect(script).toContain('Topmost="True"')
    expect(script).toContain('DeepSeekPetInputReader')
    expect(script).toContain('thread.IsBackground = true')
    expect(script).not.toContain('[Console]::In.ReadLineAsync()')
    expect(script).toContain('Cursor="Arrow"')
    expect(script).toContain('New-Animation')
    expect(script).toContain('MediaPlayer')
    expect(script).toContain("'working'")
    expect(script).toContain("'confirmation'")
    expect(icon).toContain('fill="#4D6BFE"')
    expect(icon).toContain('<path')
  })
})

describe('desktop notification configuration Remote', () => {
  function remoteFixture(documentPath?: string) {
    let revision = 2
    let user: Record<string, unknown> | undefined
    const value = { ...DEFAULT_NOTIFICATION_SETTINGS }
    const settings = {
      writable: true,
      ...(documentPath === undefined ? {} : { documentPath }),
      describe: vi.fn(() => [{
        ns: 'desktop-notifications',
        value: { ...value, ...user },
        base: DEFAULT_NOTIFICATION_SETTINGS,
        ...(user === undefined ? {} : { user }),
        revision,
      }]),
      mutate: vi.fn(async (_ns: string, ops: Array<{ op: string; path: string[]; value?: unknown }>, expected?: number) => {
        if (expected !== revision) throw new SettingsConflictError('desktop-notifications' as never, expected ?? -1, revision)
        user = { ...user }
        for (const op of ops) {
          if (op.op === 'set') user[op.path[0]!] = op.value
          else delete user[op.path[0]!]
        }
        revision += 1
      }),
    }
    const remote = new NotificationConfigRemote({
      settings,
      get: (name: string) => name === 'settings' ? settings : undefined,
      logger: { warn: vi.fn() },
    } as never)
    return { remote, settings, bump: () => { revision += 1 } }
  }

  it('returns layered values and commits a fenced field edit with write-after-read', async () => {
    const { remote, settings } = remoteFixture()
    expect(remote.describe()).toMatchObject({ registered: true, writable: true, revision: 2 })
    await expect(remote.mutate({
      op: { op: 'set', path: ['petEnabled'], value: true },
      expectedRevision: 2,
    })).resolves.toMatchObject({
      kind: 'ok',
      view: { registered: true, revision: 3, value: { petEnabled: true }, user: { petEnabled: true } },
    })
    expect(settings.mutate).toHaveBeenCalledWith(
      'desktop-notifications',
      [{ op: 'set', path: ['petEnabled'], value: true }],
      2,
    )
  })

  it('returns the latest view on conflict and rejects unknown fields at the wire boundary', async () => {
    const { remote, bump } = remoteFixture()
    bump()
    await expect(remote.mutate({
      op: { op: 'unset', path: ['petEnabled'] },
      expectedRevision: 2,
    })).resolves.toMatchObject({ kind: 'conflict', view: { registered: true, revision: 3 } })
    await expect(remote.mutate({
      op: { op: 'set', path: ['unknown'], value: true },
      expectedRevision: 3,
    } as never)).rejects.toThrow('known scalar field')
  })

  it('stores an uploaded WAV under an opaque profile-local id and selects it atomically', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-notification-'))
    try {
      const { remote, settings } = remoteFixture(join(directory, 'settings.yaml'))
      const wav = Buffer.from('RIFF\u0004\u0000\u0000\u0000WAVE', 'binary').toString('base64')
      await expect(remote.upload({
        kind: 'completion',
        fileName: 'done.wav',
        dataBase64: wav,
        expectedRevision: 2,
      })).resolves.toMatchObject({
        kind: 'ok',
        view: {
          registered: true,
          revision: 3,
          value: { completionSound: 'custom', completionCustomSoundName: 'done.wav' },
        },
      })
      expect(settings.mutate).toHaveBeenCalledWith(
        'desktop-notifications',
        expect.arrayContaining([
          { op: 'set', path: ['completionCustomSoundName'], value: 'done.wav' },
          { op: 'set', path: ['completionSound'], value: 'custom' },
        ]),
        2,
      )
      const files = await readdir(join(directory, 'desktop-notifications', 'sounds'))
      expect(files).toHaveLength(1)
      expect(files[0]).toMatch(/^completion-[0-9a-f-]{36}\.wav$/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects non-WAV upload bytes before writing settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-notification-'))
    try {
      const { remote, settings } = remoteFixture(join(directory, 'settings.yaml'))
      await expect(remote.upload({
        kind: 'confirmation',
        fileName: 'wrong.wav',
        dataBase64: Buffer.from('not a wave').toString('base64'),
        expectedRevision: 2,
      })).rejects.toThrow('RIFF/WAVE')
      expect(settings.mutate).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
