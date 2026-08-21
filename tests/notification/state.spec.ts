import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import { describe, expect, it, vi } from 'vitest'
import { Config } from '../../src/notification/host/config.ts'
import {
  PetPositionStore,
  parsePetPositionEvent,
} from '../../src/notification/host/position-store.ts'
import { NotificationConfigRemote } from '../../src/notification/host/remote.ts'
import { NotificationStateTracker } from '../../src/notification/host/state.ts'
import { DEFAULT_NOTIFICATION_SETTINGS } from '../../src/notification/shared.ts'

const execFileAsync = promisify(execFile)

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
      state: 'working', confirmation: false, completion: false, outcome: undefined,
    })
    expect(tracker.consume(root, event('tool/call', {
      turn: 1, step: 1, callId: 'question-1', name: 'ask_user_question', arguments: '{}',
    }, 1))).toEqual({ state: 'confirmation', confirmation: true, completion: false, outcome: undefined })
    expect(tracker.consume(root, event('tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'message-1',
        role: 'user',
        source: { kind: 'tool', callId: 'question-1' },
        content: [{ type: 'tool-result', toolCallId: 'question-1', content: [], isError: false }],
      },
    }, 2))).toEqual({ state: 'working', confirmation: false, completion: false, outcome: undefined })
    expect(tracker.consume(root, event('approval/asked', { id: 'approval-1', toolName: 'bash' }, 3)))
      .toEqual({ state: 'confirmation', confirmation: true, completion: false, outcome: undefined })
    expect(tracker.consume(root, event('approval/decided', { id: 'approval-1', outcome: 'allowed-once' }, 4)))
      .toEqual({ state: 'working', confirmation: false, completion: false, outcome: undefined })
    expect(tracker.consume(root, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5)))
      .toEqual({ state: 'idle', confirmation: false, completion: true, outcome: 'ready' })
  })

  it('folds concurrent sessions globally and never chimes for a subagent turn', () => {
    const tracker = new NotificationStateTracker()
    const root = session('root')
    const child = session('child', 'subagent')
    tracker.initialize([root, child])
    tracker.consume(root, event('turn/start', { turn: 1 }))
    tracker.consume(child, event('turn/start', { turn: 1 }))

    expect(tracker.consume(root, event('turn/end', { turn: 1, reason: { kind: 'completed' } })))
      .toEqual({ state: 'working', confirmation: false, completion: true, outcome: 'ready' })
    expect(tracker.consume(child, event('turn/end', { turn: 1, reason: { kind: 'completed' } })))
      .toEqual({ state: 'idle', confirmation: false, completion: false, outcome: undefined })
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
    }))).toEqual({ state: 'confirmation', confirmation: true, completion: false, outcome: undefined })
    expect(tracker.consume(root, event('tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'message-1',
        role: 'user',
        source: { kind: 'tool', callId: 'plan-1' },
        content: [{ type: 'tool-result', toolCallId: 'plan-1', content: [], isError: false }],
      },
    }))).toEqual({ state: 'working', confirmation: false, completion: false, outcome: undefined })
  })

  it('reconstructs an answered question as working from canonical DSH events', () => {
    const answered = session('answered', undefined, [
      event('turn/start', { turn: 1 }),
      event('tool/call', {
        turn: 1, step: 1, callId: 'question-1', name: 'ask_user_question', arguments: '{}',
      }, 1),
      event('tool/result', {
        turn: 1,
        step: 1,
        message: {
          id: 'message-1',
          role: 'user',
          source: { kind: 'tool', callId: 'question-1' },
          content: [{ type: 'tool-result', toolCallId: 'question-1', content: [], isError: false }],
        },
      }, 2),
    ])

    expect(new NotificationStateTracker().initialize([answered])).toBe('working')
  })

  it('shows a blocked reaction only for unsuccessful top-level turns', () => {
    const tracker = new NotificationStateTracker()
    const root = session('root')
    const child = session('child', 'subagent')
    tracker.initialize([root, child])
    tracker.consume(root, event('turn/start', { turn: 1 }))
    tracker.consume(child, event('turn/start', { turn: 1 }))

    expect(tracker.consume(root, event('turn/end', { turn: 1, reason: { kind: 'error' } })))
      .toEqual({ state: 'working', confirmation: false, completion: false, outcome: 'blocked' })
    expect(tracker.consume(child, event('turn/end', { turn: 1, reason: { kind: 'blocked' } })))
      .toEqual({ state: 'idle', confirmation: false, completion: false, outcome: undefined })
  })
})

describe('desktop notification assets and defaults', () => {
  it('resolves the complete schema defaults', () => {
    expect(Config({})).toEqual(DEFAULT_NOTIFICATION_SETTINGS)
    expect(() => Config({ petSize: 20 })).toThrow()
    expect(() => Config({ completionSound: 'unknown' })).toThrow()
    expect(() => Config({ soundGain: -1 })).toThrow()
    expect(() => Config({ soundGain: 101 })).toThrow()
    expect(() => Config({ soundGain: 50.5 })).toThrow()
  })

  it('ships a movable WPF companion with state and idle-interaction RGBA sprite sheets', async () => {
    const script = await readFile(resolve(import.meta.dirname, '../../assets/notification/desktop-pet.ps1'), 'utf8')
    const sprites = await readFile(resolve(
      import.meta.dirname,
      '../../assets/notification/deepseek-pet-sprites.png',
    ))
    const idleSprites = await readFile(resolve(
      import.meta.dirname,
      '../../assets/notification/deepseek-pet-idle-sprites.png',
    ))
    expect(script).toContain('Topmost="True"')
    expect(script).toContain('DeepSeekPetInputReader')
    expect(script).toContain('thread.IsBackground = true')
    expect(script).not.toContain('[Console]::In.ReadLineAsync()')
    expect(script).toContain('Cursor="Arrow"')
    expect(script).toContain('New-Animation')
    expect(script).toContain('New-OneShotAnimation')
    expect(script).not.toContain('Show-Hatch')
    expect(script).not.toContain('HatchShell')
    expect(script).not.toContain("$script:visualMode = 'hatch'")
    expect(script).toContain('Show-Outcome')
    expect(script).toContain("'idle-sleep'")
    expect(script).toContain("'idle-eager'")
    expect(script).toContain('Update-IdleInteractionVisual')
    expect(script).toContain('$window.Add_MouseLeave')
    expect(script).not.toContain('Play-IdleTrick')
    expect(script).toContain('CroppedBitmap')
    expect(script).toContain('Set-SpriteState')
    expect(script).toContain('Advance-SpriteAnimation')
    expect(script).toContain('$script:spriteFrameCount = 5')
    expect(script).toContain('$script:spriteColumnEdges = @(0, 311, 609, 921, 1222, 1536)')
    expect(script).toContain('$script:spriteRowEdges = @(0, 204, 396, 605, 786, 1024)')
    expect(script).toContain('$idleSpriteColumnEdges = @(0, 307, 614, 921, 1228, 1536)')
    expect(script).toContain('$idleSpriteRowEdges = @(0, 512, 1024)')
    expect(script).toContain('idle = 0')
    expect(script).toContain('working = 1')
    expect(script).toContain('confirmation = 2')
    expect(script).toContain('ready = 3')
    expect(script).toContain('blocked = 4')
    expect(script).not.toContain('(New-Animation -4 4 0.45)')
    expect(script).not.toContain('(New-Animation -5 5 0.10)')
    expect(script).not.toContain('(New-Animation -6 6 0.09)')
    expect(script).toContain('ClientAreaAnimation')
    expect(script).toContain('$script:staticSpriteFrames')
    expect(script).toContain('CapturePlacement')
    expect(script).toContain('RestorePlacement')
    expect(script).toContain('TrySelectNearestMonitor')
    expect(script).toContain('EdgeDistanceSquared')
    expect(script).toContain('DragMove remains unconstrained')
    expect(script).not.toContain('ConstrainMovingRect')
    expect(script).not.toContain('$message -eq 0x0216')
    expect(script).toContain('$message -eq 0x007E')
    expect(script).toContain('Set-TopmostForState')
    expect(script).toContain('petIdleTopmost')
    expect(script).toContain('Write-PositionEvent')
    expect(script).toContain('MediaPlayer')
    expect(script).toContain('soundGain = 0')
    expect(script).toContain('Resolve-SystemSoundPath')
    expect(script).toContain('DeepSeekNotificationGain')
    expect(script).toContain('1.0 + (gainPercent / 100.0)')
    expect(script).toContain('Math.Tanh')
    expect(script).toContain('Remove-AmplifiedSound')
    expect(script).toContain('$script:mediaPlayer.Volume = 1.0')
    expect(script).not.toContain('[System.Media.SystemSounds]')
    expect(script).toContain("'working'")
    expect(script).toContain("'confirmation'")
    expect(script).toContain('blockedSound')
    expect(script).toContain('blockedCustomSoundPath')
    expect(script).toContain("'blocked'")
    expect(sprites.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(sprites.readUInt32BE(16)).toBe(1536)
    expect(sprites.readUInt32BE(20)).toBe(1024)
    expect(sprites[24]).toBe(8)
    expect(sprites[25]).toBe(6)
    expect(idleSprites.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(idleSprites.readUInt32BE(16)).toBe(1536)
    expect(idleSprites.readUInt32BE(20)).toBe(1024)
    expect(idleSprites[24]).toBe(8)
    expect(idleSprites[25]).toBe(6)
  })

  it.runIf(process.platform === 'win32')('keeps 0% at source level and applies real 100% PCM gain', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-notification-gain-'))
    const petScript = resolve(import.meta.dirname, '../../assets/notification/desktop-pet.ps1')
    const wavePath = join(directory, 'source.wav')
    const helperPath = join(directory, 'verify-gain.ps1')
    let amplifiedPath = ''
    try {
      const samples = [8192, -8192]
      const wave = Buffer.alloc(44 + (samples.length * 2))
      wave.write('RIFF', 0, 'ascii')
      wave.writeUInt32LE(wave.length - 8, 4)
      wave.write('WAVEfmt ', 8, 'ascii')
      wave.writeUInt32LE(16, 16)
      wave.writeUInt16LE(1, 20)
      wave.writeUInt16LE(1, 22)
      wave.writeUInt32LE(8000, 24)
      wave.writeUInt32LE(16000, 28)
      wave.writeUInt16LE(2, 32)
      wave.writeUInt16LE(16, 34)
      wave.write('data', 36, 'ascii')
      wave.writeUInt32LE(samples.length * 2, 40)
      samples.forEach((sample, index) => wave.writeInt16LE(sample, 44 + (index * 2)))
      await writeFile(wavePath, wave)
      await writeFile(helperPath, String.raw`param([string]$PetScript, [string]$WavePath)
$source = Get-Content -Raw -LiteralPath $PetScript
$match = [regex]::Match($source, "(?s)Add-Type -TypeDefinition @'\r?\n(?<code>.*?)\r?\n'@")
if (-not $match.Success) { throw 'embedded C# block not found' }
Add-Type -TypeDefinition $match.Groups['code'].Value
[Console]::Out.WriteLine([DeepSeekNotificationGain]::CreateAmplifiedCopy($WavePath, 0))
[Console]::Out.WriteLine([DeepSeekNotificationGain]::CreateAmplifiedCopy($WavePath, 100))
`)
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helperPath, petScript, wavePath,
      ])
      const [original, amplified] = stdout.trim().split(/\r?\n/)
      amplifiedPath = amplified ?? ''
      expect(original).toBe(wavePath)
      expect(amplifiedPath).not.toBe(wavePath)
      const result = await readFile(amplifiedPath)
      expect(result.readInt16LE(44)).toBe(16384)
      expect(result.readInt16LE(46)).toBe(-16384)
    } finally {
      if (amplifiedPath.length > 0 && amplifiedPath !== wavePath) {
        await rm(amplifiedPath, { force: true })
      }
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('validates and persists independent normalized positions for multiple displays', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-pet-position-'))
    try {
      const settings = { documentPath: join(directory, 'settings.yaml') }
      const context = { get: (name: string) => name === 'settings' ? settings : undefined } as never
      const first = new PetPositionStore(context)
      await expect(first.load()).resolves.toBe(true)

      const displayOne = parsePetPositionEvent(JSON.stringify({
        event: 'position', display: '\\\\.\\DISPLAY1', xRatio: 0.25, yRatio: 0.75,
      }))
      const displayTwo = parsePetPositionEvent(JSON.stringify({
        event: 'position', display: '\\\\.\\DISPLAY2', xRatio: 0.8, yRatio: 0.1,
      }))
      expect(displayOne).toBeDefined()
      expect(displayTwo).toBeDefined()
      first.record(displayOne!)
      await first.persist()
      first.record(displayTwo!)
      await first.persist()

      const restored = new PetPositionStore(context)
      await expect(restored.load()).resolves.toBe(true)
      expect(restored.snapshot()).toEqual({
        version: 1,
        activeDisplay: '\\\\.\\DISPLAY2',
        displays: {
          '\\\\.\\DISPLAY1': { xRatio: 0.25, yRatio: 0.75 },
          '\\\\.\\DISPLAY2': { xRatio: 0.8, yRatio: 0.1 },
        },
      })

      await restored.reset()
      const reset = new PetPositionStore(context)
      await expect(reset.load()).resolves.toBe(true)
      expect(reset.snapshot()).toEqual({ version: 1, activeDisplay: '', displays: {} })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects malformed or out-of-range native position events', () => {
    expect(parsePetPositionEvent('not json')).toBeUndefined()
    expect(parsePetPositionEvent(JSON.stringify({
      event: 'position', display: '\\\\.\\DISPLAY1', xRatio: -0.1, yRatio: 0.5,
    }))).toBeUndefined()
    expect(parsePetPositionEvent(JSON.stringify({
      event: 'position', display: '__proto__', xRatio: 0.5, yRatio: 0.5,
    }))).toBeUndefined()
  })
})

describe('desktop notification configuration Remote', () => {
  function remoteFixture(
    documentPath?: string,
    initial: Partial<typeof DEFAULT_NOTIFICATION_SETTINGS> = {},
  ) {
    let revision = 2
    let user: Record<string, unknown> | undefined
    const value = { ...DEFAULT_NOTIFICATION_SETTINGS, ...initial }
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
    const companion = { preview: vi.fn() }
    const remote = new NotificationConfigRemote({
      settings,
      get: (name: string) => name === 'settings' ? settings : undefined,
      logger: { warn: vi.fn() },
    } as never, companion)
    return { remote, settings, companion, bump: () => { revision += 1 } }
  }

  it('returns layered values and commits a fenced field edit with write-after-read', async () => {
    const { remote, settings } = remoteFixture()
    await expect(remote.describe()).resolves.toMatchObject({
      registered: true, writable: true, revision: 2, customSounds: [],
    })
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

    await expect(remote.mutate({
      op: { op: 'set', path: ['petIdleTopmost'], value: false },
      expectedRevision: 3,
    })).resolves.toMatchObject({
      kind: 'ok',
      view: {
        registered: true,
        revision: 4,
        value: { petEnabled: true, petIdleTopmost: false },
        user: { petEnabled: true, petIdleTopmost: false },
      },
    })

    await expect(remote.mutate({
      op: { op: 'set', path: ['soundGain'], value: 65 },
      expectedRevision: 4,
    })).resolves.toMatchObject({
      kind: 'ok',
      view: { registered: true, revision: 5, value: { soundGain: 65 }, user: { soundGain: 65 } },
    })
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

  it('previews the current committed choice and keeps Off silent', async () => {
    const { remote, companion } = remoteFixture()
    await remote.preview({ kind: 'completion' })
    expect(companion.preview).toHaveBeenCalledWith('completion', {
      ...DEFAULT_NOTIFICATION_SETTINGS,
    })
    await remote.preview({ kind: 'blocked' })
    expect(companion.preview).toHaveBeenCalledWith('blocked', {
      ...DEFAULT_NOTIFICATION_SETTINGS,
    })

    await remote.mutate({
      op: { op: 'set', path: ['completionSound'], value: 'off' },
      expectedRevision: 2,
    })
    await remote.preview({ kind: 'completion' })
    expect(companion.preview).toHaveBeenCalledTimes(2)
    await expect(remote.preview({ kind: 'unknown' } as never)).rejects.toThrow('known sound kind')
  })

  it('stores multiple WAV files in one shared library and selects them independently', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-notification-'))
    try {
      const { remote, settings } = remoteFixture(join(directory, 'settings.yaml'))
      const wav = Buffer.from('RIFF\u0004\u0000\u0000\u0000WAVE', 'binary').toString('base64')
      const first = await remote.upload({ fileName: 'done.wav', dataBase64: wav })
      const second = await remote.upload({ fileName: 'attention.wav', dataBase64: wav })
      const third = await remote.upload({ fileName: 'blocked.wav', dataBase64: wav })
      expect(third).toMatchObject({
        kind: 'ok',
        view: {
          registered: true,
          revision: 2,
          customSounds: [
            { name: 'done.wav' },
            { name: 'attention.wav' },
            { name: 'blocked.wav' },
          ],
        },
      })
      if (!first.view.registered || !second.view.registered || !third.view.registered) {
        throw new Error('expected registered view')
      }
      const done = first.view.customSounds[0]!
      const attention = second.view.customSounds[1]!
      const blocked = third.view.customSounds[2]!

      await expect(remote.selectSound({
        kind: 'completion', sound: 'custom', customSoundFile: done.fileId, expectedRevision: 2,
      })).resolves.toMatchObject({
        kind: 'ok',
        view: { revision: 3, value: { completionSound: 'custom', completionCustomSoundName: 'done.wav' } },
      })
      await expect(remote.selectSound({
        kind: 'confirmation', sound: 'custom', customSoundFile: attention.fileId, expectedRevision: 3,
      })).resolves.toMatchObject({
        kind: 'ok',
        view: {
          revision: 4,
          value: { confirmationSound: 'custom', confirmationCustomSoundName: 'attention.wav' },
        },
      })
      await expect(remote.selectSound({
        kind: 'blocked', sound: 'custom', customSoundFile: blocked.fileId, expectedRevision: 4,
      })).resolves.toMatchObject({
        kind: 'ok',
        view: {
          revision: 5,
          value: { blockedSound: 'custom', blockedCustomSoundName: 'blocked.wav' },
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
      expect(files).toHaveLength(3)
      expect(files).toEqual(expect.arrayContaining([
        expect.stringMatching(/^sound-[0-9a-f-]{36}\.wav$/),
        expect.stringMatching(/^sound-[0-9a-f-]{36}\.wav$/),
      ]))
      await expect(readFile(join(directory, 'desktop-notifications', 'sound-library.json'), 'utf8'))
        .resolves.toContain('attention.wav')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('imports existing per-event custom WAV selections into the shared library', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-notification-legacy-'))
    try {
      const fileId = 'completion-97c2610c-4f42-44ff-8329-3d04f0e52680.wav'
      const soundDirectory = join(directory, 'desktop-notifications', 'sounds')
      await mkdir(soundDirectory, { recursive: true })
      await writeFile(join(soundDirectory, fileId), Buffer.from('RIFF\u0004\u0000\u0000\u0000WAVE', 'binary'))
      const { remote } = remoteFixture(join(directory, 'settings.yaml'), {
        completionSound: 'custom',
        completionCustomSoundFile: fileId,
        completionCustomSoundName: 'original-done.wav',
      })

      await expect(remote.describe()).resolves.toMatchObject({
        registered: true,
        customSounds: [{ fileId, name: 'original-done.wav' }],
      })
      await expect(readFile(join(directory, 'desktop-notifications', 'sound-library.json'), 'utf8'))
        .resolves.toContain('original-done.wav')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects non-WAV upload bytes before writing settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-notification-'))
    try {
      const { remote, settings } = remoteFixture(join(directory, 'settings.yaml'))
      await expect(remote.upload({
        fileName: 'wrong.wav',
        dataBase64: Buffer.from('not a wave').toString('base64'),
      })).rejects.toThrow('RIFF/WAVE')
      expect(settings.mutate).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
