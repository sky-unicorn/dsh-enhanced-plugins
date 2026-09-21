import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
/** Canonical workspace identity folds Windows aliases and symlinks before locking. */
export async function workspaceIdentity(cwd: string): Promise<string> {
  const path = await realpath(resolve(cwd))
  return process.platform === 'win32' ? path.toLowerCase() : path
}
/** FIFO, cancellation-aware tool lock. The delegation tool itself never takes it. */
export class WorkspaceLocks {
  private readonly tails = new Map<string, Promise<void>>()
  async run<T>(key: string, signal: AbortSignal, body: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => gate)
    this.tails.set(key, tail)
    void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key) })
    let abort!: () => void
    const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason ?? new Error('Cancelled')); signal.addEventListener('abort', abort, { once: true }) })
    try {
      signal.throwIfAborted()
      await Promise.race([previous, cancelled])
      signal.throwIfAborted()
      return await body()
    } finally {
      release()
      signal.removeEventListener('abort', abort)
    }
  }
}
