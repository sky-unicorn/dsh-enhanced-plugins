/** Execution monitoring against a real sibling Web profile; no production profile or model calls. */
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveProject } from '../packages/windows-launcher/src/toolchain.mjs'
const root = fileURLToPath(new URL('..', import.meta.url))
const dsh = resolve(root, '../deepseek-harness')
assert.ok(existsSync(dsh))
const { chromium } = createRequire(resolve(dsh, 'apps/web/package.json'))('playwright')
const scratch = resolve(root, '.verify-dsh-home')
mkdirSync(scratch, { recursive: true })
const home = mkdtempSync(resolve(scratch, 'execution-web-'))
writeFileSync(resolve(home, 'package.json'), JSON.stringify({ name: 'execution-web-fixture', type: 'module', private: true }))
const workspace = resolve(home, 'workspace'); mkdirSync(workspace)
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: 'local-fixture',
  DEEPSEEK_BASE_URL: 'http://127.0.0.1:1', DEEPSEEK_HARNESS_LAUNCHER_HOME: resolve(home, 'launcher') }
const cliArgs = resolveProject({ sourceDirectory: dsh }).args
const redact = text => text.replace(/token=[^\s"'&]+/g, 'token=[redacted]')
const run = (command, args, cwd = root) => {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 180_000 })
  if (result.status !== 0) { writeFileSync(resolve(home, 'install.log'), redact(`${result.stdout}\n${result.stderr}`)); throw new Error(`Command failed; see ${home}/install.log`) }
  return result.stdout
}
const aggregate = process.env.DSH_VERIFY_AGGREGATE === '1'
if (aggregate) {
  const packed = JSON.parse(run(process.execPath, [process.env.npm_execpath, 'pack', '--ignore-scripts', '--json', '--pack-destination', home]))[0]
  run(process.execPath, [...cliArgs, 'plugin', '--profile', 'web', 'add', resolve(home, packed.filename), '--yes'], dsh)
} else {
  const install = features => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    resolve(root, 'scripts/migrate-to-enhanced-plugin.ps1'), '-DshCheckout', dsh, '-Features', features, '-SkipBuild', '-SkipLauncherSystemIntegration'])
  install('agent-team-monitor,mcp-server-manager')
  assert.ok(existsSync(resolve(home, 'profiles/web/node_modules/dsh-enhanced-mcp-server-manager')))
  install('agent-team-monitor')
  assert.ok(!existsSync(resolve(home, 'profiles/web/node_modules/dsh-enhanced-mcp-server-manager')))
  assert.ok(existsSync(resolve(home, 'profiles/web/node_modules/dsh-enhanced-agent-team-monitor')))
}
const fixture = resolve(home, 'fixture.mjs')
writeFileSync(fixture, readFileSync(resolve(root, 'tests/agent-team-monitor/execution-web-fixture.mjs')))
const overlay = resolve(home, 'browser.patch.yml')
writeFileSync(overlay, `- id: session-log-deepseek
  config: { enabled: false }
- id: session-title-llm
  disabled: true
- id: tools
  config: { mode: native }
- insert:
    - id: execution-fixture
      name: ${JSON.stringify(fixture)}
      config: { cwd: ${JSON.stringify(workspace)} }
`)
let host, browser, page, exited
let output = ''
try {
  const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening')
  const port = probe.address().port; await new Promise(done => probe.close(done))
  host = spawn(process.execPath, [...cliArgs, 'web', '--patch', overlay, '--port', String(port), '--no-open'], { cwd: dsh, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  exited = once(host, 'exit')
  const url = await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Host startup timeout')), 90_000)
    const accept = chunk => { output += chunk.toString(); const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/); if (match) { clearTimeout(timer); done(match[1]) } }
    host.stdout.on('data', accept); host.stderr.on('data', accept)
    host.once('exit', () => { clearTimeout(timer); reject(new Error('Host exited during startup')) })
    host.once('error', reject)
  })
  browser = await chromium.launch()
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, locale: 'en-US', colorScheme: 'light' })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(url)
  await page.getByRole('dialog', { name: 'Internal Testing Notice' }).getByRole('button', { name: 'Continue', exact: true }).click({ timeout: 30_000 })
  await page.getByText('Execution monitor fixture', { exact: true }).first().click({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Show execution monitor', exact: true }).click()
  const panel = page.getByRole('dialog', { name: 'Execution monitor', exact: true })
  await page.waitForFunction(() => document.querySelectorAll('[data-cooperation-member]').length === 4)
  const seed = JSON.parse(readFileSync(resolve(workspace, 'seed.json'), 'utf8'))
  const member = panel.locator(`[data-cooperation-member="${seed.running}"]`)
  await member.getByRole('button', { name: /Progress messages/ }).click()
  await panel.getByText(/Progress: inspecting app.ts; waiting for the controlled check\./).waitFor()
  assert.equal(await member.getAttribute('data-status'), 'running')
  assert.equal(await member.getByRole('button', { name: 'Inspect callback', exact: true }).count(), 0)
  await panel.getByRole('button', { name: 'Delegation overview', exact: true }).scrollIntoViewIfNeeded()
  await panel.screenshot({ path: resolve(home, 'cooperation-running.png') })
  const graphColors = []
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(150)
    graphColors.push(await member.evaluate(element => getComputedStyle(element).backgroundColor))
    await panel.screenshot({ path: resolve(home, `cooperation-${scheme}.png`) })
  }
  assert.notEqual(graphColors[0], graphColors[1], 'Graph theme did not follow system changes')
  await panel.getByRole('button', { name: 'Member execution', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('[data-execution-lane]').length === 5)
  await panel.getByRole('button', { name: 'Include tools & turns' }).click()
  const developer = panel.locator(`[data-execution-lane="${seed.running}"]`)
  await developer.getByRole('button', { name: /inspect_fixture/ }).click()
  await panel.getByText(/"task": "HOLD/).waitFor()
  const colors = []
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(150)
    colors.push(await panel.evaluate(element => getComputedStyle(element).backgroundColor))
    await panel.screenshot({ path: resolve(home, `execution-${scheme}.png`) })
  }
  assert.notEqual(colors[0], colors[1], 'System theme did not update without reload')
  const tester = panel.locator(`[data-execution-lane="${seed.failed}"]`)
  assert.ok(await tester.locator('[data-execution-node][data-status="failed"]').count())
  await panel.getByRole('button', { name: 'Inspect member flow: Developer', exact: true }).click()
  assert.equal(await panel.locator('[data-execution-lane]').count(), 1)
  writeFileSync(resolve(workspace, 'release'), '')
  await panel.getByText('Inspected app.ts successfully.', { exact: true }).waitFor({ timeout: 30_000 })
  assert.equal(await developer.locator('[data-execution-node][data-status="running"]').count(), 0)
  await panel.getByRole('combobox').selectOption('completed')
  assert.ok(await developer.locator('[data-execution-node][data-status="completed"]').count())
  await panel.getByRole('button', { name: 'All members', exact: true }).click()
  await panel.getByRole('combobox').selectOption('all')
  await panel.screenshot({ path: resolve(home, 'execution-completed.png') })
  await panel.getByRole('button', { name: 'Delegation overview', exact: true }).click()
  await member.getByRole('button', { name: 'Inspect callback', exact: true }).click({ timeout: 30_000 })
  await panel.getByText(/Execution fixture completed\./).last().waitFor()
  assert.equal(await member.getAttribute('data-status'), 'completed')
  assert.equal(await panel.locator('[data-callback-state="received"]').count(), 1)
  await panel.screenshot({ path: resolve(home, 'cooperation-callback.png') })
  await page.setViewportSize({ width: 600, height: 900 })
  assert.ok((await panel.boundingBox()).width <= 600)
  await panel.screenshot({ path: resolve(home, 'execution-narrow.png') })
  await member.getByRole('button', { name: 'Inspect execution', exact: true }).click()
  await developer.getByRole('button', { name: /inspect_fixture/ }).click()
  await panel.getByRole('button', { name: 'Open member transcript', exact: true }).click()
  await page.locator('[data-chat-flow-key]').getByText('HOLD while inspecting app.ts', { exact: true }).waitFor()
  const zhPage = await browser.newPage({ viewport: { width: 1440, height: 1050 }, locale: 'zh-CN', colorScheme: 'dark' })
  page = zhPage
  zhPage.on('pageerror', error => errors.push(error.message))
  await zhPage.goto(url)
  // The first page already persisted the notice acknowledgement for this profile.
  await zhPage.getByText('Execution monitor fixture', { exact: true }).first().click()
  await zhPage.getByRole('button', { name: '打开执行过程监控', exact: true }).click()
  const zhPanel = zhPage.getByRole('dialog', { name: '执行过程监控', exact: true })
  await zhPanel.locator(`[data-cooperation-member="${seed.running}"]`).waitFor()
  await zhPanel.screenshot({ path: resolve(home, 'execution-zh.png') })
  await zhPanel.locator(`[data-cooperation-member="${seed.running}"]`).getByRole('button', { name: '查看回调', exact: true }).click()
  await zhPanel.getByText(/Execution fixture completed\./).last().waitFor()
  await zhPanel.screenshot({ path: resolve(home, 'execution-zh-detail.png') })
  await zhPage.close()
  assert.deepEqual(errors, [])
  writeFileSync(resolve(home, 'report.json'), JSON.stringify({ aggregate, themes: colors, graphColors, seed, liveCompletion: true, progressMessage: true, callbackReceipt: true, detail: true, narrow: true, navigation: true, errors }, null, 2))
  console.log(`Execution Web verification passed: ${home}`)
} catch (error) {
  if (page) { await page.screenshot({ path: resolve(home, 'failure.png'), fullPage: true }).catch(() => {}); writeFileSync(resolve(home, 'failure.txt'), await page.locator('body').innerText().catch(() => 'unavailable')) }
  console.error(`Verification artifacts: ${home}`)
  throw error
} finally {
  await browser?.close()
  if (host?.exitCode === null) host.kill()
  if (exited) await exited
  writeFileSync(resolve(home, 'web.log'), redact(output))
}
