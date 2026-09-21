/** Offline matched-trial analysis. Never contacts providers or reads credentials. */
import { readFile, writeFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'
const [source, destination] = process.argv.slice(2)
if (!source || !destination) throw new Error('Usage: npm run evaluate:model-router -- samples.json report.json')
if ((await stat(source)).size > 32 * 1024 * 1024) throw new Error('Evaluation input exceeds 32 MiB')
const bundled = await build({ entryPoints: [resolve('src/model-router/evaluation.ts')], bundle: true, platform: 'node', format: 'esm', write: false })
const { evaluate } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
const report = evaluate(JSON.parse(await readFile(source, 'utf8')))
await writeFile(destination, JSON.stringify(report, null, 2) + '\n')
console.log(`Compared ${report.trials} matched trials (${report.kind}); report: ${resolve(destination)}`)
