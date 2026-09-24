/** Import product toggles left under their former settings document section. */
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { parse } from 'yaml'
import { SETTINGS_NAMESPACE } from './settings.js'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Preserve existing profile overrides and copy only missing legacy booleans. */
export async function importLegacyProductToggles(ctx: Context, signal: AbortSignal): Promise<number> {
  const profile = ctx.get('profileContext') as { readonly home: string } | undefined
  if (profile === undefined) return 0
  const marker = join(profile.home, '.dsh-enhanced-subagent-settings-migrated')
  try { await access(marker); return 0 } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const loader = ctx.root.get('loader') as { await(): Promise<void> } | undefined
  if (loader !== undefined) await loader.await()
  if (signal.aborted) return 0

  let contents: string | undefined
  for (const filename of ['settings.yaml.imported', 'settings.yaml']) {
    try {
      contents = await readFile(join(profile.home, filename), { encoding: 'utf8', signal })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  if (contents === undefined || signal.aborted) return 0
  const document: unknown = parse(contents)
  const legacy = record(document) ? document['subagent-products'] : undefined
  if (legacy === undefined) return 0
  if (!record(legacy)) throw new Error('invalid legacy subagent product section')

  const descriptor = ctx.settings.describe().find(entry => entry.ns === SETTINGS_NAMESPACE)
  if (descriptor === undefined || signal.aborted) return 0
  const user = record(descriptor.user) ? descriptor.user : {}
  const ops = (['claudeCode', 'codex'] as const).flatMap(product => {
    const value = legacy[product]
    if (Object.hasOwn(user, product) || value === undefined) return []
    if (typeof value !== 'boolean') throw new Error('invalid legacy subagent product value')
    return [{ op: 'set' as const, path: [product], value }]
  })
  if (signal.aborted) return 0
  if (ops.length > 0) await ctx.settings.mutate(SETTINGS_NAMESPACE, ops, descriptor.revision)
  if (signal.aborted) return 0
  try { await writeFile(marker, '', { flag: 'wx', signal }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  return ops.length
}
