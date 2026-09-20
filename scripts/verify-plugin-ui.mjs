/** Installed plugin configuration, live unload/reload, and real Team navigation in both themes. */
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveProject } from '../packages/windows-launcher/src/toolchain.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const dsh = resolve(process.env.DSH_VERIFY_CHECKOUT ?? resolve(root, '../deepseek-harness'))
const { chromium } = createRequire(resolve(dsh, 'apps/web/package.json'))('playwright')
const scratch = resolve(root, '.verify-dsh-home')
mkdirSync(scratch, { recursive: true })
const home = mkdtempSync(resolve(scratch, 'plugin-ui-722-'))
// A file-based fixture must not inherit this repository's dsh.client manifest.
writeFileSync(resolve(home, 'package.json'), JSON.stringify({ name: 'enhanced-ui-fixture', private: true, type: 'module' }))
const workspace = resolve(home, 'workspace')
mkdirSync(workspace)
const aggregate = process.env.DSH_VERIFY_AGGREGATE === '1'
const mcpOnly = process.env.DSH_VERIFY_MCP_ONLY === '1'
assert.ok(!(aggregate && mcpOnly), 'Choose aggregate or MCP-only verification')
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1',
  DEEPSEEK_API_KEY: 'local-fixture',
  DEEPSEEK_BASE_URL: 'http://127.0.0.1:1',
  DEEPSEEK_HARNESS_LAUNCHER_HOME: resolve(home, 'launcher') }
const cliArgs = resolveProject({ sourceDirectory: dsh }).args
const redact = text => text.replace(/token=[^\s"'&]+/g, 'token=[redacted]')
const lib = relative => pathToFileURL(resolve(dsh, relative, 'lib/index.js')).href
const fixture = resolve(home, 'fixture.mjs')
const mcpFixture = resolve(home, 'mcp-fixture.cjs')
writeFileSync(mcpFixture, `
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result = message.method === 'initialize'
    ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'ui-fixture', version: '1' } }
    : message.method === 'tools/list' ? { tools: [] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
});
`)
writeFileSync(fixture, `
import { writeFileSync } from 'node:fs';
import { LlmAdapter, createUserMessage } from ${JSON.stringify(lib('packages/llm/llm'))};
import { SessionId } from ${JSON.stringify(lib('packages/core/session'))};
class Adapter extends LlmAdapter {
  async *stream() {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'UI fixture work complete.' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'UI fixture work complete.' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
export const inject = ['agents', 'llm', 'subagents', 'agentTeams', 'sessionTitle', 'sessionPersistence'];
export async function apply(ctx) {
  ctx.llm.registerAdapter(['ui-fixture'], new Adapter());
    const { agent: lead } = await ctx.agents.create({ sessionId: SessionId('enhanced-ui-parent'),
      meta: { cwd: ${JSON.stringify(workspace)} }, agentOptions: { provider: 'ui-fixture', model: 'fixture' } });
    lead.followup(createUserMessage({ content: [{ type: 'text', text: 'UI fixture parent' }], source: { kind: 'user' } }));
    await lead.whenIdle();
    ctx.sessionTitle.rename(lead.session, 'Enhanced UI parent');
    const child = await ctx.agentTeams.spawnTeammate(lead, { name: 'researcher', description: 'Check plugin UI',
      prompt: [{ type: 'text', text: 'Inspect compatibility' }], provider: 'spawn', context: 'fresh', signal: new AbortController().signal });
    const task = await ctx.agentTeams.createTask(lead, { subject: 'Inspect configuration', description: 'Verify plugin settings', writeScopes: [] });
    await ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: task.revision, action: 'reassign', owner: 'researcher' });
    await ctx.sessionPersistence.flush();
    writeFileSync(${JSON.stringify(resolve(home, 'seed.json'))}, JSON.stringify({ parent: lead.id, child: child.member.id }));
}
`)
const overlay = resolve(home, 'browser.patch.yml')
writeFileSync(overlay, `- id: session-log-deepseek
  config: { enabled: false }
- id: session-title-llm
  disabled: true
- id: directory-picker
  disabled: true
- insert:
    - id: fixture-directory-host
      name: '@deepseek-ai/dsh-host-directory-picker-browse'
    - id: fixture-directory-client
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
    - id: fixture-teams
      name: ${JSON.stringify(resolve(dsh, 'packages/experimental/agent-team/lib/index.js'))}
    - id: fixture-state
      name: ${JSON.stringify(fixture)}
`)

let child, browser, page, exited
let output = ''
try {
  let aggregateArchive
  if (aggregate) {
    const packed = spawnSync(process.execPath, [process.env.npm_execpath, 'pack', '--ignore-scripts', '--json',
      '--pack-destination', home, root], { cwd: root, encoding: 'utf8', windowsHide: true })
    assert.equal(packed.status, 0, packed.stderr)
    aggregateArchive = resolve(home, JSON.parse(packed.stdout)[0].filename)
  }
  const install = aggregate
    ? spawnSync(process.execPath, [...cliArgs, 'plugin', '--profile', 'web', 'add', aggregateArchive, '--yes'], { cwd: dsh, env, encoding: 'utf8', windowsHide: true, timeout: 120_000 })
    : spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', resolve(root, 'scripts/migrate-to-enhanced-plugin.ps1'), '-DshCheckout', dsh,
      '-Features', mcpOnly ? 'mcp-server-manager' : 'mcp-server-manager,agent-team-monitor',
      '-SkipBuild', '-SkipLauncherSystemIntegration'],
    { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 120_000 })
  writeFileSync(resolve(home, 'install.log'), redact(`${install.stdout}\n${install.stderr}`))
  assert.equal(install.status, 0, `Install failed: ${home}/install.log`)
  if (mcpOnly) {
    assert.ok(existsSync(resolve(home, 'profiles/web/node_modules/dsh-enhanced-mcp-server-manager')))
    assert.ok(!existsSync(resolve(home, 'profiles/web/node_modules/dsh-enhanced-agent-team-monitor')))
  }
  const probe = createServer().listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  await new Promise(done => probe.close(done))
  child = spawn(process.execPath, [...cliArgs, 'web', '--patch', overlay, '--port', String(port), '--no-open'],
    { cwd: dsh, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  exited = once(child, 'exit')
  const url = await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`Startup timeout: ${redact(output)}`)), 90_000)
    const accept = chunk => {
      output += chunk.toString()
      const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)
      if (match) { clearTimeout(timer); done(match[1]) }
    }
    child.stdout.on('data', accept); child.stderr.on('data', accept)
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Host exited ${code}: ${redact(output)}`)) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
  })
  browser = await chromium.launch()
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', colorScheme: 'light' })
  const errors = []
  page.on('pageerror', error => { errors.push(error.message); writeFileSync(resolve(home, 'page-errors.json'), JSON.stringify(errors)) })
  await page.goto(url)
  const notice = page.getByRole('dialog', { name: 'Internal Testing Notice' })
  await notice.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: 30_000 })
  await page.getByText('Enhanced UI parent', { exact: true }).first().click({ timeout: 30_000 })
  await page.getByText('UI fixture parent', { exact: true }).waitFor()
  const panel = page.locator('[data-plugin-panel]')
  const mcpBundle = aggregate ? 'dsh-enhanced-plugins' : 'dsh-enhanced-mcp-server-manager'
  const openRow = async (bundle, row) => {
    await page.getByRole('navigation', { name: 'Global panels' }).getByRole('button', { name: 'Plugins', exact: true }).click()
    await panel.waitFor()
    while (await panel.getByRole('button', { name: /^Back to / }).count()) await panel.getByRole('button', { name: /^Back to / }).first().click()
    await panel.getByRole('button', { name: `View ${bundle.replace(/^dsh-/, '')}`, exact: true }).click()
    await panel.getByRole('button', { name: `Configure ${row}`, exact: true }).click()
  }
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForFunction(dark => document.body.hasAttribute('data-ds-dark-theme') === dark, scheme === 'dark')
    await openRow(mcpBundle, 'mcp-manager')
    if (scheme === 'light') {
      await panel.getByRole('button', { name: 'Add server', exact: true }).click()
      const addDialog = page.getByRole('dialog', { name: 'New MCP server' })
      await addDialog.waitFor()
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'mcp-server-name',
        'MCP dialog did not focus the server name field')
      assert.equal(await panel.getByRole('textbox', { name: 'Server name', exact: true }).count(), 0,
        'MCP form rendered inline instead of in a dialog')
      await addDialog.getByRole('textbox', { name: 'Server name', exact: true }).fill('fixture-server')
      await addDialog.getByRole('textbox', { name: 'Command', exact: true }).fill(process.execPath)
      await addDialog.getByRole('textbox', { name: 'Argument 1', exact: true }).fill(mcpFixture)
      await addDialog.getByRole('button', { name: 'Add variable', exact: true }).click()
      await addDialog.getByRole('textbox', { name: 'Key 1', exact: true }).fill('UI_TOKEN')
      await addDialog.getByRole('textbox', { name: 'Value 1', exact: true }).fill('fixture-secret')
      await addDialog.getByRole('button', { name: 'Add', exact: true }).click()
      await addDialog.waitFor({ state: 'hidden' })
      await panel.getByRole('button', { name: 'Save', exact: true }).click()
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Save' && button.disabled))
      assert.ok(readFileSync(resolve(home, 'settings.yaml'), 'utf8').includes('fixture-server'), 'MCP save did not reach the Host settings document')
      await panel.getByRole('button', { name: 'Edit', exact: true }).click()
      const editDialog = page.getByRole('dialog', { name: 'Edit MCP server' })
      await editDialog.waitFor()
      assert.equal(await editDialog.getByRole('textbox', { name: 'Value 1', exact: true }).inputValue(), '••••')
      await editDialog.getByRole('textbox', { name: 'Server name', exact: true }).fill('fixture-renamed')
      await editDialog.getByRole('textbox', { name: 'Tool call timeout (ms)', exact: true }).fill('90000')
      await page.setViewportSize({ width: 760, height: 560 })
      const actionBox = await editDialog.getByRole('button', { name: 'Apply changes', exact: true }).boundingBox()
      assert.ok(actionBox && actionBox.y + actionBox.height <= 560, 'MCP dialog footer is clipped on a short viewport')
      await editDialog.getByRole('textbox', { name: 'Server name', exact: true }).scrollIntoViewIfNeeded()
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.screenshot({ path: resolve(home, 'mcp-edit-light.png'), fullPage: true })
      await editDialog.getByRole('button', { name: 'Apply changes', exact: true }).click()
      await editDialog.waitFor({ state: 'hidden' })
      await panel.getByRole('button', { name: 'Save', exact: true }).click()
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Save' && button.disabled))
      const saved = readFileSync(resolve(home, 'settings.yaml'), 'utf8')
      assert.ok(saved.includes('fixture-renamed') && saved.includes('fixture-secret') && saved.includes('90000'),
        'MCP edit did not preserve the secret and update the server')
      await panel.getByRole('button', { name: 'Edit', exact: true }).click()
      const sameNameDialog = page.getByRole('dialog', { name: 'Edit MCP server' })
      await sameNameDialog.getByRole('textbox', { name: 'Tool call timeout (ms)', exact: true }).fill('91000')
      await sameNameDialog.getByRole('button', { name: 'Apply changes', exact: true }).click()
      await panel.getByRole('button', { name: 'Save', exact: true }).click()
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Save' && button.disabled))
      const revised = readFileSync(resolve(home, 'settings.yaml'), 'utf8')
      assert.ok(revised.includes('91000') && revised.includes('fixture-secret'),
        'Same-name MCP edit did not preserve the secret and update the server')
    }
    if (scheme === 'dark') {
      await panel.getByRole('button', { name: 'Edit', exact: true }).click()
      const darkEditDialog = page.getByRole('dialog', { name: 'Edit MCP server' })
      await darkEditDialog.waitFor()
      await page.screenshot({ path: resolve(home, 'mcp-edit-dark.png'), fullPage: true })
      await darkEditDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await darkEditDialog.waitFor({ state: 'hidden' })
    }
    await panel.getByRole('button', { name: 'Add server', exact: true }).click()
    const discardDialog = page.getByRole('dialog', { name: 'New MCP server' })
    await discardDialog.getByRole('textbox', { name: 'Server name', exact: true }).fill('cancelled-fixture')
    if (scheme === 'light') {
      await discardDialog.getByRole('combobox', { name: 'Transport', exact: true }).selectOption('streamable-http')
      await discardDialog.getByRole('textbox', { name: 'URL', exact: true }).waitFor()
    }
    await page.screenshot({ path: resolve(home, `mcp-${scheme}.png`), fullPage: true })
    await page.keyboard.press('Escape')
    await discardDialog.waitFor({ state: 'hidden' })
    await panel.getByRole('button', { name: 'Add server', exact: true }).click()
    const stagedDialog = page.getByRole('dialog', { name: 'New MCP server' })
    await stagedDialog.getByRole('textbox', { name: 'Server name', exact: true }).fill('unsaved-fixture')
    await stagedDialog.getByRole('textbox', { name: 'Command', exact: true }).fill(process.execPath)
    await stagedDialog.getByRole('button', { name: 'Add', exact: true }).click()
    await panel.getByText('unsaved-fixture', { exact: true }).waitFor()
    await openRow(mcpBundle, 'mcp-manager')
    assert.equal(await panel.getByText('unsaved-fixture', { exact: true }).count(), 0, 'MCP draft survived leaving its page')
  }
  await panel.getByRole('button', { name: `Back to ${mcpBundle.replace(/^dsh-/, '')}`, exact: true }).click()
  const enableMcp = panel.getByRole('switch', { name: `Enable ${mcpBundle.replace(/^dsh-/, '')}`, exact: true })
  const waitEnabled = async enabled => page.waitForFunction(({ label, enabled }) => {
    const control = [...document.querySelectorAll('[role="switch"]')].find(element => element.getAttribute('aria-label') === label)
    return control?.getAttribute('aria-checked') === String(enabled) && !control.hasAttribute('disabled')
  }, { label: `Enable ${mcpBundle.replace(/^dsh-/, '')}`, enabled })
  await enableMcp.click()
  await waitEnabled(false)
  const graphAfterDisable = await page.evaluate(async () => {
    const html = await (await fetch('/')).text()
    const wire = html.match(/<script>globalThis\["__DSH_BOOT__"\] = ([\s\S]*?)<\/script>/)?.[1]
    return wire ? JSON.parse(wire).entries.map(entry => entry.id) : []
  })
  writeFileSync(resolve(home, 'entries-after-disable.json'), JSON.stringify(graphAfterDisable))
  assert.ok(!graphAfterDisable.includes(mcpBundle), 'Disabled bundle still contributes a Client module')
  await panel.getByRole('button', { name: 'Configure mcp-manager', exact: true }).waitFor({ state: 'hidden' })
  await enableMcp.click()
  await waitEnabled(true)
  await panel.getByRole('button', { name: 'Configure mcp-manager', exact: true }).waitFor()
  await page.reload()
  // Let the workspace owner restore its main reference before opening another panel.
  await page.getByText('Enhanced UI parent', { exact: true }).first().click({ timeout: 30_000 })
  await page.getByText('UI fixture parent', { exact: true }).waitFor()
  await openRow(mcpBundle, 'mcp-manager')
  await panel.getByRole('button', { name: 'Add server', exact: true }).waitFor()
  await page.getByText('Enhanced UI parent', { exact: true }).first().click()
  if (!mcpOnly) {
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme })
      await page.getByRole('button', { name: 'Show team monitor', exact: true }).click()
      await page.getByText('Inspect configuration', { exact: true }).first().waitFor()
      await page.screenshot({ path: resolve(home, `monitor-${scheme}.png`), fullPage: true })
      await page.getByRole('button', { name: 'Collapse team monitor', exact: true }).click()
    }
    await page.getByRole('button', { name: 'Show team monitor', exact: true }).click()
    await page.getByRole('button', { name: /^Open session details:/ }).first().click()
    await page.locator('[data-composer-input]').waitFor({ timeout: 15_000 })
  }
  const seed = JSON.parse(readFileSync(resolve(home, 'seed.json'), 'utf8'))
  if (!mcpOnly) await page.locator('[data-chat-flow-key]').getByText('Inspect compatibility', { exact: true }).waitFor()
  assert.deepEqual(errors, [])
  writeFileSync(resolve(home, 'report.json'), JSON.stringify({ aggregate, mcpOnly, settings: true, draftDiscard: true,
    teamNavigation: mcpOnly ? undefined : seed, schemes: ['light', 'dark'], errors }, null, 2))
  console.log(`Plugin UI verification passed: ${home}`)
} catch (error) {
  if (page) {
    await page.screenshot({ path: resolve(home, 'failure.png'), fullPage: true }).catch(() => {})
    writeFileSync(resolve(home, 'failure.txt'), await page.locator('body').innerText().catch(() => 'unavailable'))
  }
  console.error(`Verification artifacts: ${home}`)
  throw error
} finally {
  await browser?.close()
  if (child?.exitCode === null) child.kill()
  if (exited) await exited
  writeFileSync(resolve(home, 'web.log'), redact(output))
}
