import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { inflateSync } from 'node:zlib'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import { describe, expect, it, vi } from 'vitest'
import { Config } from '../../src/notification/host/config.ts'
import {
  migrateRetiredPetCharacter,
  normalizeNotificationUserLayer,
} from '../../src/notification/host/migration.ts'
import {
  PetPositionStore,
  parsePetPositionEvent,
} from '../../src/notification/host/position-store.ts'
import { NotificationConfigRemote } from '../../src/notification/host/remote.ts'
import { NotificationStateTracker } from '../../src/notification/host/state.ts'
import { DEFAULT_NOTIFICATION_SETTINGS } from '../../src/notification/shared.ts'

const execFileAsync = promisify(execFile)

interface RgbaPng {
  width: number
  height: number
  pixels: Buffer
}

interface SpriteFrameMetrics {
  top: number
  bottom: number
  height: number
  sharpness: number
}

function paeth(left: number, up: number, upperLeft: number): number {
  const prediction = left + up - upperLeft
  const leftDistance = Math.abs(prediction - left)
  const upDistance = Math.abs(prediction - up)
  const upperLeftDistance = Math.abs(prediction - upperLeft)
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left
  if (upDistance <= upperLeftDistance) return up
  return upperLeft
}

function decodeRgbaPng(data: Buffer): RgbaPng {
  expect(data.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  let width = 0
  let height = 0
  const compressed: Buffer[] = []
  for (let offset = 8; offset + 12 <= data.length;) {
    const length = data.readUInt32BE(offset)
    const type = data.toString('ascii', offset + 4, offset + 8)
    const payload = data.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = payload.readUInt32BE(0)
      height = payload.readUInt32BE(4)
      expect([...payload.subarray(8, 13)]).toEqual([8, 6, 0, 0, 0])
    } else if (type === 'IDAT') {
      compressed.push(payload)
    }
    offset += length + 12
    if (type === 'IEND') break
  }
  expect(width).toBeGreaterThan(0)
  expect(height).toBeGreaterThan(0)
  expect(compressed.length).toBeGreaterThan(0)

  const bytesPerPixel = 4
  const stride = width * bytesPerPixel
  const source = inflateSync(Buffer.concat(compressed))
  expect(source.length).toBe((stride + 1) * height)
  const pixels = Buffer.alloc(stride * height)
  let sourceOffset = 0
  for (let y = 0; y < height; y += 1) {
    const filter = source[sourceOffset++]
    expect(filter).toBeLessThanOrEqual(4)
    const rowOffset = y * stride
    for (let x = 0; x < stride; x += 1) {
      const raw = source[sourceOffset++]
      const left = x >= bytesPerPixel ? pixels[rowOffset + x - bytesPerPixel] : 0
      const up = y > 0 ? pixels[rowOffset + x - stride] : 0
      const upperLeft = y > 0 && x >= bytesPerPixel
        ? pixels[rowOffset + x - stride - bytesPerPixel]
        : 0
      const predictor = switchPngFilter(filter, left, up, upperLeft)
      pixels[rowOffset + x] = (raw + predictor) & 0xff
    }
  }
  return { width, height, pixels }
}

function switchPngFilter(filter: number, left: number, up: number, upperLeft: number): number {
  switch (filter) {
    case 0: return 0
    case 1: return left
    case 2: return up
    case 3: return Math.floor((left + up) / 2)
    case 4: return paeth(left, up, upperLeft)
    default: throw new TypeError(`unsupported PNG filter: ${filter}`)
  }
}

function spriteFrameMetrics(png: RgbaPng, row: number, frame: number): SpriteFrameMetrics {
  const cellSize = 256
  const grays = new Float64Array(cellSize * cellSize)
  const alphas = new Uint8Array(cellSize * cellSize)
  let top = cellSize
  let bottom = -1
  for (let y = 0; y < cellSize; y += 1) {
    for (let x = 0; x < cellSize; x += 1) {
      const sourceX = (frame * cellSize) + x
      const sourceY = (row * cellSize) + y
      const sourceOffset = ((sourceY * png.width) + sourceX) * 4
      const cellOffset = (y * cellSize) + x
      const alpha = png.pixels[sourceOffset + 3]
      alphas[cellOffset] = alpha
      grays[cellOffset] = (
        (png.pixels[sourceOffset] * 299)
        + (png.pixels[sourceOffset + 1] * 587)
        + (png.pixels[sourceOffset + 2] * 114)
      ) / 1000
      if (alpha > 16) {
        top = Math.min(top, y)
        bottom = Math.max(bottom, y)
      }
    }
  }
  expect(bottom).toBeGreaterThanOrEqual(top)

  const laplacians: number[] = []
  for (let y = 1; y < cellSize - 1; y += 1) {
    for (let x = 1; x < cellSize - 1; x += 1) {
      const offset = (y * cellSize) + x
      if (alphas[offset] <= 16) continue
      laplacians.push(
        (4 * grays[offset])
        - grays[offset - 1]
        - grays[offset + 1]
        - grays[offset - cellSize]
        - grays[offset + cellSize],
      )
    }
  }
  const mean = laplacians.reduce((sum, value) => sum + value, 0) / laplacians.length
  const sharpness = laplacians.reduce((sum, value) => sum + ((value - mean) ** 2), 0)
    / laplacians.length
  return { top, bottom, height: bottom - top + 1, sharpness }
}

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

  it('stays in confirmation until every question in one assistant step settles', () => {
    const tracker = new NotificationStateTracker()
    const root = session('question-batch')
    tracker.initialize([root])
    tracker.consume(root, event('turn/start', { turn: 1 }))

    expect(tracker.consume(root, event('assistant/message', {
      turn: 1,
      step: 1,
      message: {
        id: 'assistant-1',
        role: 'assistant',
        source: { kind: 'model', provider: 'mock', model: 'mock' },
        content: [
          { type: 'tool-call', id: 'question-1', name: 'ask_user_question', arguments: '{}' },
          { type: 'tool-call', id: 'question-2', name: 'ask_user_question', arguments: '{}' },
        ],
      },
    }, 1))).toEqual({
      state: 'confirmation', confirmation: false, completion: false, outcome: undefined,
    })
    tracker.consume(root, event('tool/call', {
      turn: 1, step: 1, callId: 'question-1', name: 'ask_user_question', arguments: '{}',
    }, 2))

    expect(tracker.consume(root, event('tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'answer-1',
        role: 'user',
        source: { kind: 'tool', callId: 'question-1' },
        content: [{ type: 'tool-result', toolCallId: 'question-1', content: [], isError: false }],
      },
    }, 3))).toEqual({
      state: 'confirmation', confirmation: false, completion: false, outcome: undefined,
    })
    tracker.consume(root, event('tool/call', {
      turn: 1, step: 1, callId: 'question-2', name: 'ask_user_question', arguments: '{}',
    }, 4))

    expect(tracker.consume(root, event('tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'answer-2',
        role: 'user',
        source: { kind: 'tool', callId: 'question-2' },
        content: [{ type: 'tool-result', toolCallId: 'question-2', content: [], isError: false }],
      },
    }, 5))).toEqual({
      state: 'working', confirmation: false, completion: false, outcome: undefined,
    })
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
    expect(Config({ petCharacter: 'whale-girl' }).petCharacter).toBe('whale-girl')
    expect(Config({ petCharacter: 'beijing-shark' } as never).petCharacter).toBe('classic')
    expect(() => Config({ petSize: 20 })).toThrow()
    expect(() => Config({ petCharacter: 'unknown' })).toThrow()
    expect(() => Config({ completionSound: 'unknown' })).toThrow()
    expect(() => Config({ soundGain: -1 })).toThrow()
    expect(() => Config({ soundGain: 101 })).toThrow()
    expect(() => Config({ soundGain: 50.5 })).toThrow()
  })

  it('persists a known retired pet character through the settings provider', async () => {
    const settings = {
      describe: vi.fn(() => [{
        ns: 'desktop-notifications',
        user: { petEnabled: true, petCharacter: 'beijing-shark' },
        revision: 7,
      }]),
      mutate: vi.fn(async () => {}),
    }

    await expect(migrateRetiredPetCharacter(settings as never)).resolves.toBe(true)
    expect(settings.mutate).toHaveBeenCalledWith(
      'desktop-notifications',
      [{ op: 'set', path: ['petCharacter'], value: 'classic' }],
      7,
    )
    expect(normalizeNotificationUserLayer({ petCharacter: 'beijing-shark' }))
      .toEqual({ petCharacter: 'classic' })
  })

  it('ships three selectable WPF pets with RGBA sprite sheets', async () => {
    const script = await readFile(resolve(import.meta.dirname, '../../assets/notification/desktop-pet.ps1'), 'utf8')
    const sprites = await readFile(resolve(
      import.meta.dirname,
      '../../assets/notification/deepseek-pet-sprites.png',
    ))
    const idleSprites = await readFile(resolve(
      import.meta.dirname,
      '../../assets/notification/deepseek-pet-idle-sprites.png',
    ))
    const multiviewSprites = await readFile(resolve(
      import.meta.dirname,
      '../../assets/notification/deepseek-multiview-pet-sprites.png',
    ))
    const whaleGirlSprites = await readFile(resolve(
      import.meta.dirname,
      '../../assets/notification/deepseek-whale-girl-pet-sprites.png',
    ))
    expect(script).toContain('Topmost="True"')
    expect(script).toContain('ShowInTaskbar="False"')
    expect(script).toContain('ToolWindowStyle = 0x00000080')
    expect(script).toContain('(current | ToolWindowStyle) & ~AppWindowStyle')
    expect(script).toContain('[DeepSeekPetNativeWindow]::HideFromTaskSwitcher($script:windowHandle)')
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
    expect(script).toContain('[string]$MultiviewSpritePath')
    expect(script).toContain('[string]$WhaleGirlSpritePath')
    expect(script).toContain('$script:classicSpriteFrameCount = 5')
    expect(script).toContain('$script:multiviewSpriteFrameCount = 24')
    expect(script).toContain('$script:whaleGirlSpriteFrameCount = 32')
    expect(script).toContain('$classicSpriteColumnEdges = @(0, 311, 609, 921, 1222, 1536)')
    expect(script).toContain('$classicSpriteRowEdges = @(0, 204, 396, 605, 786, 1024)')
    expect(script).toContain('$classicIdleSpriteColumnEdges = @(0, 307, 614, 921, 1228, 1536)')
    expect(script).toContain('$classicIdleSpriteRowEdges = @(0, 512, 1024)')
    expect(script).toContain('Select-PetSpriteSet')
    expect(script).toContain("$character -eq 'multiview'")
    expect(script).toContain("$character -eq 'whale-girl'")
    expect(script).toContain('$script:multiviewFrameSequences')
    expect(script).toContain('$script:whaleGirlFrameSequences')
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
    expect(multiviewSprites.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(multiviewSprites.readUInt32BE(16)).toBe(6144)
    expect(multiviewSprites.readUInt32BE(20)).toBe(1536)
    expect(multiviewSprites[24]).toBe(8)
    expect(multiviewSprites[25]).toBe(6)
    expect(whaleGirlSprites.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(whaleGirlSprites.readUInt32BE(16)).toBe(8192)
    expect(whaleGirlSprites.readUInt32BE(20)).toBe(1536)
    expect(whaleGirlSprites[24]).toBe(8)
    expect(whaleGirlSprites[25]).toBe(6)
  })

  it('keeps every whale girl loop sharp and anchors the stable standing reactions', async () => {
    const script = await readFile(resolve(import.meta.dirname, '../../assets/notification/desktop-pet.ps1'), 'utf8')
    const spriteData = await readFile(resolve(
      import.meta.dirname,
      '../../assets/notification/deepseek-whale-girl-pet-sprites.png',
    ))
    const sequenceSection = script.slice(script.indexOf('$script:whaleGirlFrameSequences'))
    const parseSequence = (pattern: RegExp): number[] => {
      const match = sequenceSection.match(pattern)
      expect(match).not.toBeNull()
      return (match?.[1] ?? '').split(',').map(value => Number.parseInt(value.trim(), 10))
    }
    const sequences = [
      { state: 'idle-sleep', row: 0, frames: parseSequence(/'idle-sleep' = @\(([^)]+)\)/) },
      { state: 'idle-eager', row: 1, frames: parseSequence(/'idle-eager' = @\(([^)]+)\)/) },
      { state: 'working', row: 2, frames: parseSequence(/working = @\(([^)]+)\)/) },
      { state: 'confirmation', row: 3, frames: parseSequence(/confirmation = @\(([^)]+)\)/) },
      { state: 'ready', row: 4, frames: parseSequence(/ready = @\(([^)]+)\)/) },
      { state: 'blocked', row: 5, frames: parseSequence(/blocked = @\(([^)]+)\)/) },
    ]
    const workingSequence = sequences[2]?.frames ?? []
    const blockedSequence = sequences[5]?.frames ?? []
    expect(sequences[0]?.frames).toEqual([
      0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15,
      16, 17, 18, 19, 21, 22, 23, 24, 25, 26, 27, 29, 30, 31,
    ])
    expect(workingSequence).toEqual([0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15])
    expect(blockedSequence).toEqual([0, 1, 2, 3, 5, 6, 7])

    const offsetsMatch = script.match(/\$script:whaleGirlWorkingFrameOffsets = @\{([\s\S]*?)\r?\n\}/)
    expect(offsetsMatch).not.toBeNull()
    const offsets = new Map<number, number>()
    for (const match of (offsetsMatch?.[1] ?? '').matchAll(/^\s*(\d+)\s*=\s*(-?\d+)\s*$/gm)) {
      offsets.set(Number.parseInt(match[1] ?? '', 10), Number.parseInt(match[2] ?? '', 10))
    }
    expect([...offsets.keys()]).toEqual(workingSequence)
    const legGapMatch = script.match(/\$script:whaleGirlWorkingLegGapCenters = @\{([\s\S]*?)\r?\n\}/)
    expect(legGapMatch).not.toBeNull()
    const legGapCenters = new Map<number, number>()
    for (const match of (legGapMatch?.[1] ?? '').matchAll(/^\s*(\d+)\s*=\s*(\d+(?:\.\d+)?)\s*$/gm)) {
      legGapCenters.set(Number.parseInt(match[1] ?? '', 10), Number.parseFloat(match[2] ?? ''))
    }
    expect([...legGapCenters.keys()]).toEqual(workingSequence)
    const parseLegGapProfiles = (name: string): Map<number, [number, number, number]> => {
      const match = script.match(new RegExp(`\\$script:${name} = @\\{([\\s\\S]*?)\\r?\\n\\}`))
      expect(match, `${name} must be declared`).not.toBeNull()
      const profiles = new Map<number, [number, number, number]>()
      for (const entry of (match?.[1] ?? '').matchAll(
        /^\s*(\d+)\s*=\s*@\((\d+(?:\.\d+)?),\s*(\d+),\s*(\d+(?:\.\d+)?)\)\s*$/gm,
      )) {
        profiles.set(Number.parseInt(entry[1] ?? '', 10), [
          Number.parseFloat(entry[2] ?? ''),
          Number.parseInt(entry[3] ?? '', 10),
          Number.parseFloat(entry[4] ?? ''),
        ])
      }
      return profiles
    }
    const standingLegGapProfiles = [
      {
        state: 'idle-eager',
        row: 1,
        profiles: parseLegGapProfiles('whaleGirlIdleEagerLegGapProfiles'),
        frames: [...Array.from({ length: 12 }, (_, frame) => frame), ...Array.from({ length: 16 }, (_, frame) => frame + 16)],
      },
      {
        state: 'confirmation',
        row: 3,
        profiles: parseLegGapProfiles('whaleGirlConfirmationLegGapProfiles'),
        frames: Array.from({ length: 32 }, (_, frame) => frame),
      },
      {
        state: 'ready',
        row: 4,
        profiles: parseLegGapProfiles('whaleGirlReadyLegGapProfiles'),
        frames: [...Array.from({ length: 5 }, (_, frame) => frame), ...Array.from({ length: 19 }, (_, frame) => frame + 13)],
      },
      {
        state: 'blocked',
        row: 5,
        profiles: parseLegGapProfiles('whaleGirlBlockedLegGapProfiles'),
        frames: blockedSequence,
      },
    ]
    for (const state of standingLegGapProfiles) {
      expect([...state.profiles.keys()], `${state.state} upright gap coverage`).toEqual(state.frames)
    }
    expect(standingLegGapProfiles[0]?.profiles.get(20)).toEqual([148, 172, 152.5])
    const blockedOffsetsMatch = script.match(/\$script:whaleGirlBlockedFrameOffsets = @\{([\s\S]*?)\r?\n\}/)
    expect(blockedOffsetsMatch).not.toBeNull()
    const blockedOffsets = new Map<number, number>()
    for (const match of (blockedOffsetsMatch?.[1] ?? '').matchAll(/^\s*(\d+)\s*=\s*(-?\d+)\s*$/gm)) {
      blockedOffsets.set(Number.parseInt(match[1] ?? '', 10), Number.parseInt(match[2] ?? '', 10))
    }
    expect([...blockedOffsets.keys()]).toEqual(blockedSequence)
    expect(script).toContain(
      '$petMotion.Y = [double]$frameOffsets[$bounded] * 104.0 / 256.0',
    )
    expect(script).toContain('[System.Windows.Media.GeometryCombineMode]::Exclude')
    expect(script).toContain('($gapCenter - 2.0) * $sourceScale')
    expect(script).toContain('4.0 * $sourceScale')
    expect(script).toContain('[System.Windows.Media.StreamGeometry]::new()')
    expect(script).toContain('($topCenter - 1.0) * $sourceScale')
    expect(script).toContain('($bottomCenter + 6.0) * $sourceScale')

    const png = decodeRgbaPng(spriteData)
    expect([png.width, png.height]).toEqual([8192, 1536])
    const playbackMetrics = sequences.map(sequence => ({
      ...sequence,
      metrics: sequence.frames.map(frame => spriteFrameMetrics(png, sequence.row, frame)),
    }))
    for (const sequence of playbackMetrics) {
      expect(
        Math.min(...sequence.metrics.map(metric => metric.sharpness)),
        `${sequence.state} contains a blurred live frame`,
      ).toBeGreaterThan(8000)
    }

    const workingMetrics = playbackMetrics[2]?.metrics ?? []
    const workingHeights = workingMetrics.map(metric => metric.height)
    expect(Math.max(...workingHeights) - Math.min(...workingHeights)).toBeLessThanOrEqual(2)
    const workingBottoms = workingMetrics.map((metric, index) => {
      const offset = offsets.get(workingSequence[index] ?? -1)
      expect(offset).toBeDefined()
      return metric.bottom + (offset ?? Number.NaN)
    })
    expect(workingBottoms).toEqual(Array.from({ length: workingSequence.length }, () => 250))
    for (const frame of workingSequence) {
      const center = legGapCenters.get(frame)
      expect(center).toBeDefined()
      expect(center).toBeGreaterThanOrEqual(139.5)
      expect(center).toBeLessThanOrEqual(143.5)
      const centerX = Math.round(center ?? Number.NaN)
      const sourceY = (2 * 256) + 212
      const sourceX = (frame * 256) + centerX
      const sourceOffset = ((sourceY * png.width) + sourceX) * 4
      expect(png.pixels[sourceOffset + 3], `frame ${frame} leg gap must remove painted pixels`).toBeGreaterThan(16)
    }

    for (const state of standingLegGapProfiles) {
      for (const [frame, [topCenter, topY, bottomCenter]] of state.profiles) {
        const sampleY = Math.round(topY + ((230 - topY) * 0.55))
        const progress = (sampleY - topY) / (256 - topY)
        const sampleX = Math.round(topCenter + ((bottomCenter - topCenter) * progress))
        const sourceOffset = ((((state.row * 256) + sampleY) * png.width) + (frame * 256) + sampleX) * 4
        const sourcePixel = png.pixels.subarray(sourceOffset, sourceOffset + 4)
        expect(sourcePixel[3], `${state.state} frame ${frame} gap must cover painted source pixels`).toBeGreaterThan(16)
        expect(
          Math.min(sourcePixel[0] ?? 0, sourcePixel[1] ?? 0, sourcePixel[2] ?? 0),
          `${state.state} frame ${frame} gap must follow the pale background wedge`,
        ).toBeGreaterThan(145)
      }
    }

    const blockedMetrics = playbackMetrics[5]?.metrics ?? []
    const blockedHeights = blockedMetrics.map(metric => metric.height)
    expect(Math.max(...blockedHeights) - Math.min(...blockedHeights)).toBeLessThanOrEqual(1)
    const blockedBottoms = blockedMetrics.map((metric, index) => {
      const offset = blockedOffsets.get(blockedSequence[index] ?? -1)
      expect(offset).toBeDefined()
      return metric.bottom + (offset ?? Number.NaN)
    })
    expect(blockedBottoms).toEqual(Array.from({ length: blockedSequence.length }, () => 251))
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

    await expect(remote.mutate({
      op: { op: 'set', path: ['petCharacter'], value: 'whale-girl' },
      expectedRevision: 5,
    })).resolves.toMatchObject({
      kind: 'ok',
      view: {
        registered: true,
        revision: 6,
        value: { petCharacter: 'whale-girl' },
        user: { petCharacter: 'whale-girl' },
      },
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
