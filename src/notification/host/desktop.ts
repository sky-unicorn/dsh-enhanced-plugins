/** Managed Windows PowerShell/WPF companion for sound and the global desktop pet. */

import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  NotificationSettings, NotificationSoundEvent, PetOutcome, PetState,
} from '../shared.js'
import {
  PetPositionStore,
  parsePetPositionEvent,
  type PetPlacementState,
} from './position-store.js'
import { customSoundPath } from './sound-files.js'

interface CompanionMessage {
  command: 'config' | 'effect' | 'sound' | 'state' | 'stop'
  config?: NotificationSettings & {
    completionCustomSoundPath?: string
    confirmationCustomSoundPath?: string
    blockedCustomSoundPath?: string
    placementState?: PetPlacementState
  }
  kind?: NotificationSoundEvent
  outcome?: PetOutcome
  state?: PetState
}

const SCRIPT_PATH = fileURLToPath(new URL('../../../assets/notification/desktop-pet.ps1', import.meta.url))
const SPRITE_PATH = fileURLToPath(new URL('../../../assets/notification/deepseek-pet-sprites.png', import.meta.url))
const IDLE_SPRITE_PATH = fileURLToPath(new URL('../../../assets/notification/deepseek-pet-idle-sprites.png', import.meta.url))
const MULTIVIEW_SPRITE_PATH = fileURLToPath(
  new URL('../../../assets/notification/deepseek-multiview-pet-sprites.png', import.meta.url),
)

/** Owns exactly one companion process and serializes its stdin protocol. */
export class DesktopCompanion {
  private handle: SubprocessHandle | undefined
  private executable: string | undefined
  private settings: NotificationSettings
  private state: PetState = 'idle'
  private tail: Promise<void> = Promise.resolve()
  private placementTail: Promise<void> = Promise.resolve()
  private readonly positionStore: PetPositionStore
  private placementLoaded = false
  private configured = false
  private disposed = false
  private retryAfter = 0

  constructor(
    private readonly ctx: Context,
    initial: NotificationSettings,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    this.settings = initial
    this.positionStore = new PetPositionStore(ctx)
  }

  /** Apply live settings and start or stop the persistent pet as required. */
  configure(settings: NotificationSettings): void {
    const startingCornerChanged = this.configured && settings.petPosition !== this.settings.petPosition
    this.configured = true
    this.settings = settings
    this.enqueue(async () => {
      await this.loadPlacement()
      if (startingCornerChanged) {
        await this.placementTail
        await this.positionStore.reset()
      }
      if (settings.petEnabled) {
        const handle = await this.ensure()
        if (handle !== undefined) {
          await this.send(handle, { command: 'config', config: this.companionConfig() })
          await this.send(handle, { command: 'state', state: this.state })
        }
      } else if (this.handle !== undefined) {
        await this.stop(this.handle)
      }
    })
  }

  /** Update the persistent pet; the state is retained while the pet is disabled. */
  setState(state: PetState): void {
    this.state = state
    if (!this.settings.petEnabled) return
    this.enqueue(async () => {
      const handle = await this.ensure()
      if (handle !== undefined) await this.send(handle, { command: 'state', state: this.state })
    })
  }

  /** Play a transient completion or blocked reaction without changing task state. */
  showOutcome(outcome: PetOutcome): void {
    if (!this.settings.petEnabled) return
    this.enqueue(async () => {
      const handle = await this.ensure()
      if (handle !== undefined) await this.send(handle, { command: 'effect', outcome })
    })
  }

  /** Play one configured sound, using a short-lived companion when the pet is hidden. */
  play(kind: NotificationSoundEvent): void {
    this.playConfigured(kind, () => this.settings)
  }

  /** Preview one authoritative settings snapshot without exposing its custom path to the browser. */
  preview(kind: NotificationSoundEvent, settings: NotificationSettings): void {
    this.playConfigured(kind, () => settings)
  }

  private playConfigured(kind: NotificationSoundEvent, settingsSource: () => NotificationSettings): void {
    if (settingsSource()[`${kind}Sound`] === 'off') return
    this.enqueue(async () => {
      const settings = settingsSource()
      if (settings[`${kind}Sound`] === 'off') return
      const handle = await this.ensure()
      if (handle === undefined) return
      await this.send(handle, { command: 'config', config: this.companionConfig(settings) })
      await this.send(handle, { command: 'sound', kind })
      if (!settings.petEnabled) {
        await this.stop(handle, settings[`${kind}Sound`] === 'custom' ? 30_500 : 1_500)
      }
    })
  }

  /** Stop accepting work and join the managed companion process tree. */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.tail
    if (this.handle !== undefined) await this.stop(this.handle)
    await this.placementTail
  }

  private enqueue(operation: () => Promise<void>): void {
    if (this.disposed) return
    this.tail = this.tail.then(operation).catch((error: unknown) => {
      this.ctx.logger.warn(`desktop notifications: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  private async ensure(): Promise<SubprocessHandle | undefined> {
    if (this.disposed) return undefined
    if (this.platform !== 'win32') {
      if (this.retryAfter === 0) {
        this.retryAfter = Number.POSITIVE_INFINITY
        this.ctx.logger.warn('desktop notifications: native sounds and the desktop pet require Windows')
      }
      return undefined
    }
    if (this.handle !== undefined) return this.handle
    if (Date.now() < this.retryAfter) return undefined
    try {
      await this.loadPlacement()
      this.executable ??= await this.ctx.subprocess.resolveExecutable('powershell.exe')
      const handle = this.ctx.subprocess.spawn({
        argv: [
          this.executable,
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-STA',
          '-File',
          SCRIPT_PATH,
          '-SpritePath',
          SPRITE_PATH,
          '-IdleSpritePath',
          IDLE_SPRITE_PATH,
          '-MultiviewSpritePath',
          MULTIVIEW_SPRITE_PATH,
        ],
        cwd: dirname(SCRIPT_PATH),
        stdio: {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: { maxBytes: 16_384 },
        },
        graceMs: 1_500,
      })
      this.handle = handle
      this.attachOutput(handle)
      void handle.done.then(
        (outcome) => {
          if (this.handle === handle) this.handle = undefined
          if (!this.disposed && outcome.exitCode !== 0) {
            const stderr = handle.collected.stderr?.readFrom(0).text.trim()
            this.ctx.logger.warn(
              `desktop notifications: companion exited with code ${String(outcome.exitCode)}`
              + (stderr === undefined || stderr === '' ? '' : `: ${stderr}`),
            )
          }
        },
        (error: unknown) => {
          if (this.handle === handle) this.handle = undefined
          if (!this.disposed) this.ctx.logger.warn(`desktop notifications: companion failed: ${String(error)}`)
        },
      )
      await this.send(handle, { command: 'config', config: this.companionConfig() })
      await this.send(handle, { command: 'state', state: this.state })
      return handle
    } catch (error) {
      this.handle = undefined
      this.retryAfter = Date.now() + 30_000
      this.ctx.logger.warn(`desktop notifications: unable to start Windows companion: ${String(error)}`)
      return undefined
    }
  }

  private send(handle: SubprocessHandle, message: CompanionMessage): Promise<void> {
    const stdin = handle.stdin
    if (stdin === undefined || stdin.destroyed) return Promise.reject(new Error('companion stdin is unavailable'))
    const line = `${JSON.stringify(message)}\n`
    return new Promise<void>((resolve, reject) => {
      stdin.write(line, 'utf8', (error?: Error | null) => {
        if (error === undefined || error === null) resolve()
        else reject(error)
      })
    })
  }

  private companionConfig(settings: NotificationSettings = this.settings): NonNullable<CompanionMessage['config']> {
    const completionCustomSoundPath = customSoundPath(this.ctx, settings.completionCustomSoundFile)
    const confirmationCustomSoundPath = customSoundPath(this.ctx, settings.confirmationCustomSoundFile)
    const blockedCustomSoundPath = customSoundPath(this.ctx, settings.blockedCustomSoundFile)
    const placementState = this.positionStore.snapshot()
    return {
      ...settings,
      ...(completionCustomSoundPath === undefined ? {} : { completionCustomSoundPath }),
      ...(confirmationCustomSoundPath === undefined ? {} : { confirmationCustomSoundPath }),
      ...(blockedCustomSoundPath === undefined ? {} : { blockedCustomSoundPath }),
      ...(placementState.activeDisplay === '' ? {} : { placementState }),
    }
  }

  private async loadPlacement(): Promise<void> {
    if (this.placementLoaded) return
    try {
      this.placementLoaded = await this.positionStore.load()
    } catch (error) {
      this.placementLoaded = true
      this.ctx.logger.warn(
        `desktop notifications: unable to read saved pet position: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private attachOutput(handle: SubprocessHandle): void {
    const stdout = handle.stdout
    if (stdout === undefined) throw new Error('companion stdout is unavailable')
    stdout.setEncoding('utf8')
    let buffered = ''
    stdout.on('data', (chunk: string) => {
      buffered += chunk
      if (buffered.length > 16_384) {
        buffered = ''
        this.ctx.logger.warn('desktop notifications: discarded oversized companion output')
        return
      }
      let newline = buffered.indexOf('\n')
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim()
        buffered = buffered.slice(newline + 1)
        const event = parsePetPositionEvent(line)
        if (event !== undefined) {
          this.positionStore.record(event)
          this.placementTail = this.placementTail.then(() => this.positionStore.persist()).catch((error: unknown) => {
            this.ctx.logger.warn(
              `desktop notifications: unable to save pet position: ${error instanceof Error ? error.message : String(error)}`,
            )
          })
        }
        newline = buffered.indexOf('\n')
      }
    })
  }

  private async stop(handle: SubprocessHandle, graceMs = 1_500): Promise<void> {
    if (this.handle === handle) this.handle = undefined
    try {
      await this.send(handle, { command: 'stop' })
    } catch {
      // A process that already closed needs no cooperative stop.
    }
    handle.stdin?.end()
    const exited = await handle.waitForExit(AbortSignal.timeout(graceMs))
    if (exited) return
    handle.terminate()
    await handle.waitForExit()
  }
}
