/** Managed Windows PowerShell/WPF companion for sound and the global desktop pet. */

import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NotificationSettings, PetState } from '../shared.js'
import { customSoundPath } from './sound-files.js'

type SoundEvent = 'completion' | 'confirmation'

interface CompanionMessage {
  command: 'config' | 'sound' | 'state' | 'stop'
  config?: NotificationSettings & {
    completionCustomSoundPath?: string
    confirmationCustomSoundPath?: string
  }
  kind?: SoundEvent
  state?: PetState
}

const SCRIPT_PATH = fileURLToPath(new URL('../../../assets/notification/desktop-pet.ps1', import.meta.url))
const ICON_PATH = fileURLToPath(new URL('../../../assets/notification/deepseek-fish.svg', import.meta.url))

/** Owns exactly one companion process and serializes its stdin protocol. */
export class DesktopCompanion {
  private handle: SubprocessHandle | undefined
  private executable: string | undefined
  private settings: NotificationSettings
  private state: PetState = 'idle'
  private tail: Promise<void> = Promise.resolve()
  private disposed = false
  private retryAfter = 0

  constructor(
    private readonly ctx: Context,
    initial: NotificationSettings,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    this.settings = initial
  }

  /** Apply live settings and start or stop the persistent pet as required. */
  configure(settings: NotificationSettings): void {
    this.settings = settings
    this.enqueue(async () => {
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

  /** Play one configured sound, using a short-lived companion when the pet is hidden. */
  play(kind: SoundEvent): void {
    if (this.settings[`${kind}Sound`] === 'off') return
    this.enqueue(async () => {
      if (this.settings[`${kind}Sound`] === 'off') return
      const handle = await this.ensure()
      if (handle === undefined) return
      await this.send(handle, { command: 'config', config: this.companionConfig() })
      await this.send(handle, { command: 'sound', kind })
      if (!this.settings.petEnabled) {
        await this.stop(handle, this.settings[`${kind}Sound`] === 'custom' ? 30_500 : 1_500)
      }
    })
  }

  /** Stop accepting work and join the managed companion process tree. */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.tail
    if (this.handle !== undefined) await this.stop(this.handle)
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
          '-IconPath',
          ICON_PATH,
        ],
        cwd: dirname(SCRIPT_PATH),
        stdio: {
          stdin: 'pipe',
          stdout: { maxBytes: 4_096 },
          stderr: { maxBytes: 16_384 },
        },
        graceMs: 1_500,
      })
      this.handle = handle
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

  private companionConfig(): NonNullable<CompanionMessage['config']> {
    const completionCustomSoundPath = customSoundPath(this.ctx, this.settings.completionCustomSoundFile)
    const confirmationCustomSoundPath = customSoundPath(this.ctx, this.settings.confirmationCustomSoundFile)
    return {
      ...this.settings,
      ...(completionCustomSoundPath === undefined ? {} : { completionCustomSoundPath }),
      ...(confirmationCustomSoundPath === undefined ? {} : { confirmationCustomSoundPath }),
    }
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
