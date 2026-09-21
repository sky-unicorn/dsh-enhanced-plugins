import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { fingerprint } from './policy.js'

/** Bounded file-state evidence. Symlinks, out-of-workspace paths and oversized
 * scopes are deliberately unverifiable; they require human/main-agent review. */
export async function scopeFingerprint(cwd: string, scope: string[]): Promise<string | undefined> {
  if (!scope.length) return undefined
  if (scope.some(path => /[*?]/.test(path))) return undefined
  const root = await realpath(cwd).catch(() => undefined)
  if (!root) return undefined
  const rows: [string, string][] = []; let bytes = 0; let count = 0
  const visit = async (path: string): Promise<void> => {
    const rel = relative(root, path)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../')) throw new Error('outside scope')
    if (++count > 2000) throw new Error('large scope')
    let stat
    try { stat = await lstat(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { rows.push([rel, 'missing']); return }
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error('symlink scope')
    // Also reject traversal through a symlink parent.
    const resolved = await realpath(path)
    if (resolved.toLowerCase() !== path.toLowerCase()) throw new Error('indirect scope')
    if (stat.isDirectory()) {
      rows.push([rel, 'directory'])
      for (const entry of (await readdir(path)).sort()) {
        if (['.git', 'node_modules'].includes(entry)) continue
        await visit(resolve(path, entry))
      }
    } else if (stat.isFile()) {
      bytes += stat.size
      if (bytes > 16 * 1024 * 1024) throw new Error('large scope')
      rows.push([rel, fingerprint((await readFile(path)).toString('base64'))])
    } else throw new Error('special file')
  }
  try { for (const item of [...new Set(scope)].sort()) await visit(resolve(root, item)); return fingerprint(rows) } catch { return undefined }
}
