import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { DesktopCompanion } from '../../src/notification/host/desktop.ts'
import { DEFAULT_NOTIFICATION_SETTINGS } from '../../src/notification/shared.ts'

class ClosingWritable extends Writable {
  writes = 0
  failWrites = false

  override _write(
    _chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.writes += 1
    if (!this.failWrites) {
      callback()
      return
    }
    const error = new Error('write EPIPE') as NodeJS.ErrnoException
    error.code = 'EPIPE'
    callback(error)
  }
}

describe('DesktopCompanion lifecycle', () => {
  it('contains an EPIPE when stdin closes during cooperative disposal', async () => {
    const stdin = new ClosingWritable()
    const stdout = new PassThrough()
    const waitForExit = vi.fn(async () => true)
    const logger = { warn: vi.fn() }
    const handle = {
      pid: 123,
      stdin,
      stdout,
      stderr: undefined,
      collected: {
        stderr: {
          readFrom: () => ({ text: '', nextOffset: 0, lossy: false }),
        },
      },
      done: new Promise<never>(() => {}),
      terminate: vi.fn(),
      waitForExit,
    }
    const ctx = {
      get: vi.fn(() => undefined),
      logger,
      subprocess: {
        resolveExecutable: vi.fn(async () => 'powershell.exe'),
        spawn: vi.fn(() => handle),
      },
    }
    const settings = { ...DEFAULT_NOTIFICATION_SETTINGS, petEnabled: true }
    const companion = new DesktopCompanion(ctx as never, settings, 'win32')

    companion.configure(settings)
    await vi.waitFor(() => { expect(stdin.writes).toBe(4) })
    expect(stdin.listenerCount('error')).toBe(1)

    stdin.failWrites = true
    await expect(companion.dispose()).resolves.toBeUndefined()
    await new Promise<void>((resolve) => { setImmediate(resolve) })

    expect(stdin.writes).toBe(5)
    expect(waitForExit).toHaveBeenCalledOnce()
    expect(logger.warn).not.toHaveBeenCalled()
  })
})
