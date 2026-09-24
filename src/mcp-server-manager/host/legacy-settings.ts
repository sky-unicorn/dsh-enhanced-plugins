/** Import the MCP section left behind when DSH moved settings into profile entries. */
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { parse } from 'yaml'
import { MCP_SETTINGS_NAMESPACE, type Config } from './schema.js'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Copy only missing servers from the preserved pre-rc.1 document. The active
 * Loader entry and settings service own validation and the committed write.
 */
export async function importLegacyMcpSettings(ctx: Context, signal: AbortSignal): Promise<number> {
  const profile = ctx.get('profileContext') as { readonly home: string } | undefined
  if (profile === undefined) return 0
  const marker = join(profile.home, '.dsh-enhanced-mcp-settings-migrated')
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
  const legacy = record(document) ? document['mcp'] : undefined
  if (legacy === undefined) return 0
  if (!record(legacy) || !record(legacy['servers'])) throw new Error('invalid legacy MCP section')

  const descriptor = ctx.settings.describe().find(entry => entry.ns === MCP_SETTINGS_NAMESPACE)
  if (descriptor === undefined || signal.aborted) return 0
  const current = descriptor.value as Config
  const servers = record(current.servers) ? current.servers : {}
  const ops = Object.entries(legacy['servers'])
    .filter(([name]) => !Object.hasOwn(servers, name))
    .map(([name, value]) => ({ op: 'set' as const, path: ['servers', name], value }))
  if (signal.aborted) return 0
  if (ops.length > 0) await ctx.settings.mutate(MCP_SETTINGS_NAMESPACE, ops, descriptor.revision)
  if (signal.aborted) return 0
  try { await writeFile(marker, '', { flag: 'wx', signal }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  return ops.length
}
