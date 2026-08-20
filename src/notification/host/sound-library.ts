/** Persistent shared catalog for profile-local custom notification sounds. */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { NotificationCustomSound, NotificationSettings } from '../shared.js'
import {
  customSoundPath,
  isCustomSoundFileId,
  profileSoundRoot,
  removeCustomSound,
  saveCustomSound,
  soundDisplayName,
} from './sound-files.js'

const STATE_VERSION = 1
const MAX_CUSTOM_SOUNDS = 64

interface SoundLibraryState {
  version: typeof STATE_VERSION
  sounds: NotificationCustomSound[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function decodeState(value: unknown): SoundLibraryState {
  if (!isPlainObject(value) || value['version'] !== STATE_VERSION || !Array.isArray(value['sounds'])) {
    throw new TypeError('custom sound library has an invalid document shape')
  }
  if (value['sounds'].length > MAX_CUSTOM_SOUNDS) {
    throw new TypeError(`custom sound library exceeds the ${MAX_CUSTOM_SOUNDS}-sound limit`)
  }
  const seen = new Set<string>()
  const sounds = value['sounds'].map((entry: unknown) => {
    if (!isPlainObject(entry)
      || typeof entry['fileId'] !== 'string'
      || !isCustomSoundFileId(entry['fileId'])
      || typeof entry['name'] !== 'string'
      || soundDisplayName(entry['name']) !== entry['name']
      || seen.has(entry['fileId'])) {
      throw new TypeError('custom sound library contains an invalid entry')
    }
    seen.add(entry['fileId'])
    return { fileId: entry['fileId'], name: entry['name'] }
  })
  return { version: STATE_VERSION, sounds }
}

function legacySounds(settings: NotificationSettings): NotificationCustomSound[] {
  const candidates = [
    { fileId: settings.completionCustomSoundFile, name: settings.completionCustomSoundName },
    { fileId: settings.confirmationCustomSoundFile, name: settings.confirmationCustomSoundName },
  ]
  const sounds: NotificationCustomSound[] = []
  for (const candidate of candidates) {
    if (!isCustomSoundFileId(candidate.fileId) || sounds.some(entry => entry.fileId === candidate.fileId)) continue
    try {
      if (soundDisplayName(candidate.name) !== candidate.name) continue
    } catch {
      continue
    }
    sounds.push(candidate)
  }
  return sounds
}

/** Owns library metadata, atomic writes, migration, and serialized uploads. */
export class CustomSoundLibrary {
  private state: SoundLibraryState = { version: STATE_VERSION, sounds: [] }
  private loadPromise: Promise<void> | undefined
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly ctx: Context) {}

  /** List existing files and import valid selections from the previous per-event model. */
  async list(settings: NotificationSettings): Promise<NotificationCustomSound[]> {
    await this.ensureLoaded()
    await this.enqueue(async () => {
      let changed = false
      const available: NotificationCustomSound[] = []
      for (const entry of this.state.sounds) {
        const path = customSoundPath(this.ctx, entry.fileId)
        if (path !== undefined) {
          try {
            await access(path)
            available.push(entry)
            continue
          } catch {
            // Missing files are pruned from the owner catalog below.
          }
        }
        changed = true
      }
      if (changed) this.state = { ...this.state, sounds: available }
      for (const entry of legacySounds(settings)) {
        if (this.state.sounds.some(candidate => candidate.fileId === entry.fileId)) continue
        const path = customSoundPath(this.ctx, entry.fileId)
        if (path === undefined) continue
        try {
          await access(path)
        } catch {
          continue
        }
        if (this.state.sounds.length >= MAX_CUSTOM_SOUNDS) break
        this.state = { ...this.state, sounds: [...this.state.sounds, entry] }
        changed = true
      }
      if (changed) await this.persist()
    })
    return this.snapshot()
  }

  /** Add one WAV without changing either task event's current selection. */
  async upload(
    settings: NotificationSettings,
    fileName: string,
    dataBase64: string,
  ): Promise<NotificationCustomSound> {
    await this.list(settings)
    let stored: NotificationCustomSound | undefined
    await this.enqueue(async () => {
      if (this.state.sounds.length >= MAX_CUSTOM_SOUNDS) {
        throw new Error(`custom sound library supports at most ${MAX_CUSTOM_SOUNDS} files`)
      }
      stored = await saveCustomSound(this.ctx, fileName, dataBase64)
      try {
        this.state = { ...this.state, sounds: [...this.state.sounds, stored] }
        await this.persist()
      } catch (error) {
        this.state = {
          ...this.state,
          sounds: this.state.sounds.filter(entry => entry.fileId !== stored?.fileId),
        }
        await removeCustomSound(this.ctx, stored.fileId)
        throw error
      }
    })
    if (stored === undefined) throw new Error('custom sound library upload did not complete')
    return stored
  }

  /** Resolve only entries already admitted to the shared catalog. */
  async find(settings: NotificationSettings, fileId: string): Promise<NotificationCustomSound | undefined> {
    const sounds = await this.list(settings)
    return sounds.find(entry => entry.fileId === fileId)
  }

  private snapshot(): NotificationCustomSound[] {
    return this.state.sounds.map(entry => ({ ...entry }))
  }

  private ensureLoaded(): Promise<void> {
    this.loadPromise ??= this.load()
    return this.loadPromise
  }

  private async load(): Promise<void> {
    const path = this.libraryPath()
    if (path === undefined) return
    try {
      this.state = decodeState(JSON.parse(await readFile(path, 'utf8')) as unknown)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new Error(`unable to read custom sound library: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.tail.then(operation)
    this.tail = run.catch(() => {})
    return run
  }

  private libraryPath(): string | undefined {
    const root = profileSoundRoot(this.ctx)
    return root === undefined ? undefined : resolve(dirname(root), 'sound-library.json')
  }

  private async persist(): Promise<void> {
    const path = this.libraryPath()
    if (path === undefined) {
      throw new Error('custom sound library requires a settings provider document path')
    }
    const temporary = `${path}.${randomUUID()}.tmp`
    await mkdir(dirname(path), { recursive: true })
    try {
      await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      await rename(temporary, path)
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
  }
}
