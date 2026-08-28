import { resolve } from 'node:path'

/** Match public package entries exactly so new subpath exports keep normal resolution. */
export function exactDshAliases(aliases: Record<string, string>) {
  return Object.entries({
    '@deepseek-ai/dsh-client-store': resolve(import.meta.dirname, '../../deepseek-harness/packages/client/store/lib/index.js'),
    ...aliases,
  }).map(([name, replacement]) => ({
    find: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
    replacement,
  }))
}
