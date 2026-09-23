/** Real DSH assembly: selective packages, native installation, management and both themes. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveProject } from '../packages/windows-launcher/src/toolchain.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const dsh = resolve(root, '../deepseek-harness')
const { chromium } = createRequire(resolve(dsh, 'apps/web/package.json'))('playwright')
const scratch = resolve(root, '.verify-dsh-home')
mkdirSync(scratch, { recursive: true })
const reuse = process.env.DSH_VERIFY_MARKET_HOME
const home = reuse ? resolve(reuse) : mkdtempSync(resolve(scratch, 'market-native-'))
assert.ok(home.startsWith(`${scratch}${sep}`), 'Verification must use a scratch profile inside this repository')
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1',
  DEEPSEEK_API_KEY: 'local-fixture', DEEPSEEK_BASE_URL: 'http://127.0.0.1:1' }
const cli = resolveProject({ sourceDirectory: dsh }).args
const profile = 'market-check'
const manifestPath = resolve(home, 'profiles', profile, 'package.json')
if (!reuse) {
  const initialize = spawnSync(process.execPath, [...cli, '--profile', profile, '--from-default-profile', 'web', '--dump-config'],
    { cwd: dsh, env, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  assert.equal(initialize.status, 0, initialize.stderr)
  const migrate = features => {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', resolve(root, 'scripts/migrate-to-enhanced-plugin.ps1'), '-DshCheckout', dsh,
      '-Profile', profile, '-Features', features, '-SkipBuild', '-SkipLauncherSystemIntegration'],
    { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 180_000 })
    writeFileSync(resolve(home, `selection-${features.replaceAll(',', '-')}.log`), `${result.stdout}\n${result.stderr}`)
    assert.equal(result.status, 0, `Selection ${features} failed: ${home}`)
    return JSON.parse(readFileSync(manifestPath, 'utf8'))
  }
  const single = migrate('plugin-market')
  assert.ok(single.dependencies['dsh-enhanced-plugin-market'])
  assert.ok(!single.dependencies['dsh-enhanced-plugins'])
  assert.ok(!single.dependencies['dsh-enhanced-mcp-server-manager'])
  console.log('Standalone market selection passed')
  const combined = migrate('plugin-market,mcp-server-manager')
  assert.ok(combined.dependencies['dsh-enhanced-plugin-market'])
  assert.ok(combined.dependencies['dsh-enhanced-mcp-server-manager'])
  console.log('Combined selection passed')
  const reselected = migrate('plugin-market')
  assert.ok(reselected.dependencies['dsh-enhanced-plugin-market'])
  assert.ok(!reselected.dependencies['dsh-enhanced-mcp-server-manager'])
  console.log('Reselection cleanup passed')
}

const fixture = resolve(home, 'fixture')
mkdirSync(fixture, { recursive: true })
writeFileSync(resolve(fixture, 'package.json'), JSON.stringify({ name: 'dsh-market-native-fixture', version: '1.0.0',
  type: 'module', dsh: { bundle: { patch: './cordis.patch.yml' } }, exports: './index.js' }))
writeFileSync(resolve(fixture, 'index.js'), 'export const name = "market-native-fixture"; export function apply() {}\n')
writeFileSync(resolve(fixture, 'cordis.patch.yml'), '- insert:\n    - id: market-native-fixture\n      name: dsh-market-native-fixture\n')
const overlay = resolve(home, 'browser.patch.yml')
writeFileSync(overlay, '- id: session-log-deepseek\n  config: { enabled: false }\n- id: session-title-llm\n  disabled: true\n')
const probe = createServer().listen(0, '127.0.0.1')
await once(probe, 'listening')
const port = probe.address().port
await new Promise(done => probe.close(done))
let child, browser, page
let output = ''
const redact = text => text.replace(/token=[^\s"'&]+/g, 'token=[redacted]')
try {
  child = spawn(process.execPath, [...cli, '--profile', profile, '--patch', overlay, '--port', String(port), '--no-open'],
    { cwd: dsh, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const url = await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`Startup timeout: ${redact(output)}`)), 90_000)
    const accept = chunk => {
      output += chunk.toString()
      const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)
      if (match) { clearTimeout(timer); done(match[1]) }
    }
    child.stdout.on('data', accept); child.stderr.on('data', accept)
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Host exited ${code}: ${redact(output)}`)) })
  })
  browser = await chromium.launch()
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', colorScheme: 'light' })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(url)
  const notice = page.getByRole('dialog', { name: 'Internal Testing Notice' })
  await notice.waitFor({ timeout: 3000 }).catch(() => {})
  if (await notice.isVisible()) await notice.getByRole('button', { name: 'Continue', exact: true }).click()
  const later = page.getByRole('button', { name: 'Configure later', exact: true })
  await later.waitFor({ timeout: 5000 }).then(() => later.click()).catch(() => {})
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Plugin Community', exact: true }).click()
  await page.getByRole('heading', { name: 'Plugin Community', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Install with DSH', exact: true }).first().waitFor()
  const navButton = page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Plugin Community', exact: true })
  await page.waitForFunction(() => !!document.querySelector('[data-dsh-plugin-community-nav-icon] svg path'))
  assert.equal(await page.getByText('Check install method', { exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Configure', exact: true }).count(), 0)
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme })
    await page.waitForFunction(dark => document.body.hasAttribute('data-ds-dark-theme') === dark, theme === 'dark')
    assert.equal(await navButton.locator('[data-dsh-plugin-community-nav-icon] svg').isVisible(), true)
    assert.equal(await navButton.locator('svg').last().evaluate(node => getComputedStyle(node).display), 'none')
    await page.screenshot({ path: resolve(home, `market-${theme}.png`), fullPage: true })
  }
  // Substitute only a catalog source with a local package. The actual native Remote,
  // pnpm, profile persistence, bundle validation and activation remain untouched.
  await page.route('**/api/plugin-market/catalog?**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({
    plugins: [{ fullName: 'fixture/native-install', packageName: 'dsh-market-native-fixture', description: 'Local native installation fixture',
      url: 'https://github.com/deepseek-harness/deepseek-harness', ownerAvatarUrl: '', stars: 0, topics: [], installSpec: fixture }],
    fetchedAt: new Date().toISOString(), indexStale: false, page: 1, pageSize: 12, total: 1, totalPages: 1,
  }) }))
  await page.getByRole('searchbox').fill('native-install')
  await page.getByText('fixture/native-install', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Install with DSH', exact: true }).click()
  await page.getByText(/DSH installed and enabled the plugin\.|DSH saved the change\. Restart to apply it\./).waitFor({ timeout: 120_000 })
  const installed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.ok(installed.dependencies['dsh-market-native-fixture'])
  assert.ok(installed.dsh.profile.bundles.includes('dsh-market-native-fixture'))
  await page.screenshot({ path: resolve(home, 'native-install.png'), fullPage: true })
  await page.getByRole('button', { name: 'Manage installed plugins', exact: true }).click()
  await page.getByRole('dialog', { name: 'Settings', exact: true }).waitFor({ state: 'hidden' })
  await page.locator('[data-plugin-panel]').waitFor()
  await page.getByRole('button', { name: 'View market-native-fixture', exact: true }).click()
  await page.screenshot({ path: resolve(home, 'native-management.png'), fullPage: true })
  assert.deepEqual(errors, [])
  writeFileSync(resolve(home, 'report.json'), JSON.stringify({ selection: reuse ? 'reused scratch profile' : 'single, combined, reselected', nativeInstall: 'passed',
    currentProfile: profile, themes: ['light', 'dark'], nativeManagement: 'passed', errors }, null, 2))
  console.log(`Market native Web verification passed: ${home}`)
} catch (error) {
  if (page) {
    await page.screenshot({ path: resolve(home, 'failure.png'), fullPage: true }).catch(() => {})
    writeFileSync(resolve(home, 'failure.txt'), await page.locator('body').innerText().catch(() => ''))
  }
  throw error
} finally {
  writeFileSync(resolve(home, 'host.log'), redact(output))
  await browser?.close()
  if (child && child.exitCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    else child.kill('SIGTERM')
  }
}
