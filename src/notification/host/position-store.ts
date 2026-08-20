/** Profile-local persistence for dragged desktop-pet positions. */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const STATE_VERSION = 1
const MAX_STATE_BYTES = 64 * 1024

export interface PetDisplayPlacement {
  /** Horizontal position within the monitor's usable range, from 0 to 1. */
  xRatio: number
  /** Vertical position within the monitor's usable range, from 0 to 1. */
  yRatio: number
}

export interface PetPlacementState {
  version: typeof STATE_VERSION
  activeDisplay: string
  displays: Record<string, PetDisplayPlacement>
}

export interface PetPositionEvent extends PetDisplayPlacement {
  event: 'position'
  display: string
}

function emptyState(): PetPlacementState {
  return { version: STATE_VERSION, activeDisplay: '', displays: {} }
}

function validDisplay(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    && !/[\u0000-\u001f\u007f]/.test(value)
    && value !== '__proto__'
    && value !== 'constructor'
    && value !== 'prototype'
}

function validRatio(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

/** Validate one newline-delimited event from the native helper. */
export function parsePetPositionEvent(line: string): PetPositionEvent | undefined {
  if (line.length === 0 || line.length > 4_096) return undefined
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record['event'] !== 'position' || !validDisplay(record['display'])
    || !validRatio(record['xRatio']) || !validRatio(record['yRatio'])) return undefined
  return {
    event: 'position',
    display: record['display'],
    xRatio: record['xRatio'],
    yRatio: record['yRatio'],
  }
}

function parseState(text: string): PetPlacementState {
  if (text.length === 0 || Buffer.byteLength(text, 'utf8') > MAX_STATE_BYTES) {
    throw new TypeError('desktop pet position state is empty or oversized')
  }
  const value: unknown = JSON.parse(text)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('desktop pet position state must be an object')
  }
  const record = value as Record<string, unknown>
  const rawDisplays = record['displays']
  if (record['version'] !== STATE_VERSION || !validDisplay(record['activeDisplay'])
    || rawDisplays === null || typeof rawDisplays !== 'object' || Array.isArray(rawDisplays)) {
    throw new TypeError('desktop pet position state has an unsupported shape')
  }
  const displays: Record<string, PetDisplayPlacement> = {}
  for (const [display, rawPlacement] of Object.entries(rawDisplays)) {
    if (!validDisplay(display) || rawPlacement === null || typeof rawPlacement !== 'object'
      || Array.isArray(rawPlacement)) {
      throw new TypeError('desktop pet position state contains an invalid display')
    }
    const placement = rawPlacement as Record<string, unknown>
    if (!validRatio(placement['xRatio']) || !validRatio(placement['yRatio'])) {
      throw new TypeError('desktop pet position state contains an invalid coordinate')
    }
    displays[display] = { xRatio: placement['xRatio'], yRatio: placement['yRatio'] }
  }
  if (displays[record['activeDisplay']] === undefined) {
    throw new TypeError('desktop pet position state active display is missing')
  }
  return { version: STATE_VERSION, activeDisplay: record['activeDisplay'], displays }
}

/** Owns the in-memory placement projection and its optional profile-local file. */
export class PetPositionStore {
  private state = emptyState()

  constructor(private readonly ctx: Context) {}

  /** Load once settings exposes a profile document. False means retry later. */
  async load(): Promise<boolean> {
    const target = this.target()
    if (target === undefined) return false
    try {
      this.state = parseState(await readFile(target, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.state = emptyState()
    }
    return true
  }

  /** Return an isolated snapshot safe to send across the helper protocol. */
  snapshot(): PetPlacementState {
    return {
      ...this.state,
      displays: Object.fromEntries(
        Object.entries(this.state.displays).map(([display, placement]) => [display, { ...placement }]),
      ),
    }
  }

  /** Fold one trusted-and-validated helper event into the multi-display table. */
  record(event: PetPositionEvent): void {
    this.state = {
      version: STATE_VERSION,
      activeDisplay: event.display,
      displays: {
        ...this.state.displays,
        [event.display]: { xRatio: event.xRatio, yRatio: event.yRatio },
      },
    }
  }

  /** Atomically persist the latest in-memory snapshot when a profile is available. */
  async persist(): Promise<void> {
    const target = this.target()
    if (target === undefined || this.state.activeDisplay === '') return
    await mkdir(dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(this.state)}\n`, { flag: 'wx', mode: 0o600 })
      await rename(temporary, target)
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
    }
  }

  /** Forget all dragged positions so the configured starting corner applies again. */
  async reset(): Promise<void> {
    this.state = emptyState()
    const target = this.target()
    if (target === undefined) return
    await unlink(target).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }

  private target(): string | undefined {
    const documentPath = this.ctx.get('settings')?.documentPath
    return documentPath === undefined
      ? undefined
      : resolve(dirname(documentPath), 'desktop-notifications', 'pet-position.json')
  }
}
