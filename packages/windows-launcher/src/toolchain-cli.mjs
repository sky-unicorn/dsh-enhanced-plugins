import fs from 'node:fs'
import { inspectToolchain, prepareToolchain } from './toolchain.mjs'

try {
  const request = JSON.parse(fs.readFileSync(process.argv[3], 'utf8').replace(/^\uFEFF/, ''))
  const mode = process.argv[2]
  if (!['inspect', 'prepare'].includes(mode)) throw new Error('Unsupported toolchain operation.')
  const plan = mode === 'prepare' ? prepareToolchain(request) : inspectToolchain(request)
  process.stdout.write(JSON.stringify(mode === 'inspect' ? plan.summary : {
    summary: plan.summary, environment: plan.environment, args: plan.args,
  }))
} catch (error) {
  process.stderr.write(error.message)
  process.exitCode = 1
}
