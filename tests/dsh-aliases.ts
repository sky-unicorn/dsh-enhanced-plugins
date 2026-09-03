import { resolve } from 'node:path'

/** Prepared DSH checkout used by integration tests; defaults to the required sibling. */
export const dshCheckout = resolve(process.env.DSH_VERIFY_CHECKOUT ?? resolve(import.meta.dirname, '../../deepseek-harness'))

/** Match public package entries exactly so new subpath exports keep normal resolution. */
export function exactDshAliases(aliases: Record<string, string>) {
  return Object.entries({
    '@deepseek-ai/dsh-client-store': resolve(dshCheckout, 'packages/client/store/lib/index.js'),
    ...aliases,
  }).map(([name, replacement]) => ({
    find: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
    replacement,
  }))
}
