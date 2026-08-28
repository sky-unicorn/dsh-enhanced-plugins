import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const manifest = new URL('../../package.json', import.meta.url)
const inRepository = existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === 'dsh-enhanced-plugins'
const script = new URL(inRepository ? '../../scripts/build-standalone.mjs' : './build-support.mjs', import.meta.url)
const { buildStandalone } = await import(script.href)
await buildStandalone(fileURLToPath(new URL('.', import.meta.url)))
