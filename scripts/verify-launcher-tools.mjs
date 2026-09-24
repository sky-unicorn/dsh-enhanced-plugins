/** Exercise the installed Launcher and a real DSH tool call without external model/search credentials. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { discoverNvm, inspectToolchain } from '../packages/windows-launcher/src/toolchain.mjs'

if (process.platform !== 'win32') throw new Error('This gate requires Windows Launcher.')
const root = fileURLToPath(new URL('..', import.meta.url))
const dsh = resolve(process.env.DSH_VERIFY_CHECKOUT ?? resolve(root, '../deepseek-harness'))
assert.ok(existsSync(resolve(dsh, 'apps/cli/lib/bin.js')), 'Build the sibling DSH checkout first.')
const scratch = resolve(root, '.verify-dsh-home')
mkdirSync(scratch, { recursive: true })
const home = mkdtempSync(resolve(scratch, 'launcher-tools-'))
const launcherHome = resolve(home, 'launcher')
const workspace = resolve(home, 'workspace')
mkdirSync(workspace)
writeFileSync(resolve(home, 'package.json'), JSON.stringify({ name: 'launcher-tool-fixture', private: true, type: 'module' }))
const inputFile = resolve(workspace, 'probe.txt')
writeFileSync(inputFile, 'LAUNCHER_TOOL_DISPATCH_OK\n')
const env = { ...process.env, DSH_HOME: home, DEEPSEEK_HARNESS_LAUNCHER_HOME: launcherHome,
  DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: 'local-fixture', DEEPSEEK_BASE_URL: 'http://127.0.0.1:1',
  DSH_COMPATIBILITY_URL: 'http://127.0.0.1:1/compatibility.json' }
const redact = text => text.replace(/token=[^\s"'&]+/g, 'token=[redacted]')
const json = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
const lib = relative => pathToFileURL(resolve(dsh, relative, 'lib/index.js')).href
const fixture = resolve(home, 'fixture.mjs')
writeFileSync(fixture, `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LlmAdapter, createUserMessage, ToolCallId } from ${JSON.stringify(lib('packages/llm/llm'))};
import { SessionId } from ${JSON.stringify(lib('packages/core/session'))};
class Adapter extends LlmAdapter {
  requests = 0;
  async *stream() {
    if (++this.requests === 1) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('launcher-read'), name: 'read',
        arguments: ${JSON.stringify(JSON.stringify({ file_path: inputFile }))} } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'COMPLETE' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'COMPLETE' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
}
export const inject = ['agents', 'agentLoop', 'llm', 'agentPresets', 'settings'];
export async function apply(ctx) {
  const mode = process.env.DSH_LAUNCHER_PROBE_CASE;
  ctx.llm.registerAdapter(['launcher-fixture'], new Adapter());
  const { agent } = await ctx.agents.create({ sessionId: SessionId('launcher-tool-' + mode),
    meta: { cwd: ${JSON.stringify(workspace)}, agentPreset: 'standard' },
    setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    agentOptions: { provider: 'launcher-fixture', model: 'fixture' } });
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Read the fixture file.' }], source: { kind: 'user' } }));
  await agent.whenIdle();
  const events = agent.session.snapshotEvents();
  const result = events.find(event => event.type === 'tool/result')?.data.message;
  const end = events.findLast(event => event.type === 'turn/end')?.data.reason;
  writeFileSync(join(${JSON.stringify(home)}, mode + '-tool.json'), JSON.stringify({
    completed: end?.kind === 'completed', resultRecorded: result !== undefined,
    isError: result?.isError ?? false, contentMatched: JSON.stringify(result?.content ?? []).includes('LAUNCHER_TOOL_DISPATCH_OK'),
    mcpRegistered: ctx.settings.describe().some(entry => entry.ns === 'mcp-manager'),
    reason: end,
  }, null, 2));
}
`)

function run(file, args, environment = env) {
  const result = spawnSync(file, args, { cwd: root, env: environment, encoding: 'utf8', windowsHide: true, timeout: 120_000 })
  assert.equal(result.status, 0, `${file}: ${result.error?.message ?? ''}\n${redact(result.stdout ?? '')}\n${redact(result.stderr ?? '')}`)
  return result
}
async function until(check, label) {
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(done => setTimeout(done, 200))
  }
  throw new Error(`Timed out: ${label}; artifacts: ${home}`)
}
async function freePort() {
  const server = createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(done => server.close(done))
  return port
}

// Reproduce an existing pre-fix install so this gate also covers link-to-archive migration.
run(process.execPath, [resolve(dsh, 'apps/cli/lib/bin.js'), 'plugin', '--profile', 'web', 'add',
  resolve(root, 'packages/mcp-server-manager'), '--yes'])
assert.match(json(resolve(home, 'profiles/web/package.json')).dependencies['dsh-enhanced-mcp-server-manager'], /^link:/)
const installed = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', resolve(root, 'scripts/migrate-to-enhanced-plugin.ps1'), '-DshCheckout', dsh,
  '-Features', 'mcp-server-manager', '-SkipBuild', '-SkipLauncherSystemIntegration'])
writeFileSync(resolve(home, 'install.log'), redact(`${installed.stdout}\n${installed.stderr}`))
const executable = json(resolve(launcherHome, 'current.json')).executable
const settingsPath = resolve(launcherHome, 'settings.json')
const settings = json(settingsPath)
const installedMcp = realpathSync(resolve(home, 'profiles/web/node_modules/dsh-enhanced-mcp-server-manager'))
assert.ok(installedMcp.toLowerCase().startsWith(resolve(home, 'profiles/web').toLowerCase()),
  'Installed bundle escaped the profile runtime resolver through a source link')
const invoker = readFileSync(settings.DshCommand, 'utf8').replaceAll('\\', '/')
assert.ok(invoker.includes('apps/cli/lib/bin.js'), 'Managed invoker did not select built CLI')
assert.doesNotMatch(invoker, /--import|TSX_TSCONFIG_PATH|apps\/cli\/src\/bin/)
writeFileSync(resolve(home, 'profiles/web/cordis.patch.yml'), `- id: session-log-deepseek
  config: { enabled: false }
- id: session-title-llm
  disabled: true
- id: directory-picker
  disabled: true
- insert:
    - id: launcher-tool-fixture
      name: ${JSON.stringify(fixture)}
`)
const nvm = discoverNvm(env)
const modes = [...(nvm ? ['nvm'] : []), 'system']
const report = []
for (const mode of modes) {
  const environment = { ...env, DSH_LAUNCHER_PROBE_CASE: mode }
  if (mode === 'system') {
    Object.assign(environment, { NVM_HOME: '', NVM_DIR: '', APPDATA: resolve(home, 'appdata'), LOCALAPPDATA: resolve(home, 'localappdata'),
      PATH: (env.PATH ?? env.Path ?? '').split(';').filter(directory => !existsSync(resolve(directory || '.', 'nvm.exe'))).join(';') })
    assert.equal(discoverNvm(environment), null)
  }
  const nodeVersion = mode === 'nvm' && nvm.versions.some(item => item.version === process.versions.node) ? process.versions.node : ''
  // An optional local pnpm package keeps this runtime gate independent of a cold registry download.
  // The production toolchain still verifies the copied manager's version and Node compatibility.
  if (mode === 'nvm' && process.env.DSH_VERIFY_MANAGER_ROOT) {
    const plan = inspectToolchain({ sourceDirectory: dsh, nodeVersion, sandboxHome: resolve(launcherHome, 'sandbox') }, environment)
    assert.ok(plan.home, plan.summary.message)
    const managerRoot = resolve(process.env.DSH_VERIFY_MANAGER_ROOT)
    const manifest = json(resolve(managerRoot, 'package.json'))
    assert.equal(manifest.name, 'pnpm')
    cpSync(managerRoot, resolve(plan.home, 'managers', manifest.version, 'node_modules/pnpm'), { recursive: true })
  }
  writeFileSync(settingsPath, JSON.stringify({ ...settings, NoOpen: true, Port: await freePort(), WorkingDirectory: workspace,
    NodeVersion: nodeVersion }))
  let started = false
  try {
    const startResult = resolve(home, `${mode}-start.json`)
    run(executable, ['--automation', 'start', startResult], environment)
    assert.equal(json(startResult).success, true)
    started = true
    const outcomePath = resolve(home, `${mode}-tool.json`)
    await until(() => {
      if (existsSync(outcomePath)) return true
      const statePath = resolve(launcherHome, 'run/web-state.json')
      if (existsSync(statePath) && json(statePath).status === 'stopped') {
        throw new Error(`${mode} Web stopped before the tool result; see ${launcherHome}/logs/dsh-web.log`)
      }
      return false
    }, `${mode} tool execution`)
    const outcome = json(outcomePath)
    assert.deepEqual([outcome.completed, outcome.resultRecorded, outcome.isError, outcome.contentMatched, outcome.mcpRegistered],
      [true, true, false, true, true], JSON.stringify(outcome))
    report.push({ mode, ...outcome })
    console.log(`${mode}: installed Launcher executed the official read tool successfully`)
  } finally {
    if (started) {
      const stopResult = resolve(home, `${mode}-stop.json`)
      run(executable, ['--automation', 'stop-and-wait', stopResult], environment)
      assert.equal(json(stopResult).success, true)
    }
  }
}
writeFileSync(resolve(home, 'report.json'), JSON.stringify(report, null, 2))
console.log(`Launcher tool dispatch verification passed: ${home}`)
