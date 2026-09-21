/** Real DSH Web, isolated profile and keyless adapter. No sibling checkout writes. */
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveProject } from '../packages/windows-launcher/src/toolchain.mjs'
const root = fileURLToPath(new URL('..', import.meta.url))
const dsh = resolve(root, '../deepseek-harness')
const { chromium } = createRequire(resolve(dsh, 'apps/web/package.json'))('playwright')
const scratch = resolve(root, '.verify-dsh-home'); mkdirSync(scratch, { recursive: true })
const home = mkdtempSync(resolve(scratch, 'model-router-v3-'))
const workspace = resolve(home, 'workspace'); mkdirSync(workspace, { recursive: true })
writeFileSync(resolve(workspace, 'fixture.txt'), 'expected: 42\nactual: 41\nPreserve existing user work.\n')
writeFileSync(resolve(home, 'package.json'), JSON.stringify({ name: 'model-router-fixture', private: true, type: 'module' }))
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path')),
  Path: `${dirname(process.execPath)};${process.env.Path ?? process.env.PATH}`, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1',
  DEEPSEEK_API_KEY: 'local-fixture', DEEPSEEK_BASE_URL: 'http://127.0.0.1:1', DEEPSEEK_HARNESS_LAUNCHER_HOME: resolve(home, 'launcher') }
const cliArgs = resolveProject({ sourceDirectory: dsh }).args
const lib = relative => pathToFileURL(resolve(dsh, relative, 'lib/index.js')).href
const fixture = resolve(home, 'fixture.mjs')
writeFileSync(fixture, `
import { writeFileSync } from 'node:fs';
import { LlmAdapter, createUserMessage } from ${JSON.stringify(lib('packages/llm/llm'))};
import { SessionId } from ${JSON.stringify(lib('packages/core/session'))};
class Adapter extends LlmAdapter {
  childSteps = 0;
  async resolveModel(provider, id) { return { provider, id, name: id, context: { contextWindow: 131072 } }; }
  async listModels(provider) { if (provider === 'router-fixture-unavailable') throw new Error('Controlled catalog failure'); return ['light','normal','strong','original'].map(id => ({provider,id,name:id})); }
  async *stream(options) {
    const main = options.tools?.some(t => t.name === 'model_router_delegate_task');
    const prior = options.messages.some(m => m.role === 'tool' || m.content.some(b => b.type === 'tool-result'));
    let name, args;
    if (main && !prior) {
      name = 'model_router_delegate_task'; args = { role: 'execute', reason: 'A bounded implementation needs an executor and later verification.', title: 'Verify acceptance mismatch', objective: 'Diagnose why expected 42 differs from actual 41', scope: ['fixture.txt'], acceptance: ['Actual value equals expected value'], constraints: ['Preserve existing user work'], context: 'Controlled keyless fixture; inspect both facts before suggesting a correction.' };
    } else if (!main && options.model === 'normal' && this.childSteps < 5) {
      const step = this.childSteps++; name = 'read'; args = { file_path: ${JSON.stringify(resolve(workspace, 'fixture.txt'))}, ...(step % 2 ? { offset: step === 1 ? 1 : 2, limit: 1 } : {}) };
    }
    if (name && !main && options.tools?.some(t => t.name === 'run_code')) { args = { code: 'console.log(await tools.' + name + '(' + JSON.stringify(args) + '))', description: 'Inspect acceptance evidence' }; name = 'run_code'; }
    if (name) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call', toolCallId: 'fixture-call-' + this.childSteps + '-' + Number(main), toolName: name };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'fixture-call-' + this.childSteps + '-' + Number(main), name, arguments: JSON.stringify(args) } };
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 5, reasoningTokens: 3, totalTokens: 35 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
    }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'Router fixture complete: ' + options.model };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Router fixture complete: ' + options.model } };
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
export const inject = ['agents', 'llm', 'modelRouter', 'settings', 'sessionTitle', 'sessionPersistence', 'sessionController', 'agentDefaultModel', 'sessionProjections', 'typertGateway'];
export async function apply(ctx) {
  ctx.llm.registerAdapter(['router-fixture', 'router-fixture-unavailable'], new Adapter());
  await ctx.settings.mutate('enhanced-model-router', [
    { op: 'set', path: ['models'], value: Object.fromEntries(['light', 'normal', 'strong'].map(model => [model, {provider:'router-fixture',model}])) },
    { op: 'set', path: ['enabled'], value: true },
    { op: 'set', path: ['limits', 'maxRequests'], value: 1 },
    { op: 'set', path: ['limits', 'maxChildExecutions'], value: 1 },
    { op: 'set', path: ['budget'], value: { tokenLimitEnabled: true, maxTotalTokens: 1 } },
  ]);
  const cold = await ctx.agents.create({ sessionId: SessionId('router-cold'), meta: { cwd: ${JSON.stringify(workspace)} }, agentOptions: { provider: 'router-fixture', model: 'light' } });
  await ctx.sessionController.selectModel({ sessionId: cold.agent.id, provider: 'router-fixture', model: 'light' });
  await ctx.sessionPersistence.flush();
  await cold.dispose();
  if (ctx.agents.get(SessionId('router-cold'))) throw new Error('Cold session still active');
  await ctx.agentDefaultModel.saveSelection({ provider: 'router-fixture', model: 'strong' });
  const coldSelection = await ctx.modelRouter.selectionBridge.capture('router-cold');
  if (coldSelection.model !== 'light') throw new Error('Cold session original selection lost');
  await ctx.sessionController.create({ sessionId: SessionId('router-parent'), cwd: ${JSON.stringify(workspace)}, agentPreset: 'standard' });
  await ctx.sessionController.selectModel({ sessionId: SessionId('router-parent'), provider: 'router-fixture', model: 'original' });
  const fresh = await ctx.modelRouter.describe('router-parent');
  if (fresh.control.mode !== 'off') throw new Error('New sessions must opt in');
  await ctx.modelRouter.command({ sessionId: 'router-parent', action: 'mode', mode: 'auto', expectedRevision: fresh.control.revision, operationId: 'fixture-enable' });
  let rejected = false;
  try { await ctx.sessionController.selectModel({ sessionId: SessionId('router-parent'), provider: 'router-fixture', model: 'strong' }); } catch { rejected = true; }
  if (!rejected) throw new Error('Managed selection bypassed Host guard');
  let remoteRejected = false;
  try { await ctx.typertGateway.invoke({ namespace: 'session', method: 'selectModel', args: { request: { sessionId: 'router-parent', provider: 'router-fixture', model: 'strong' } } }); } catch (error) { remoteRejected = error.message.includes('Turn off model collaboration'); }
  if (!remoteRejected) throw new Error('Remote selection bypassed Host guard');
  const agent = ctx.agents.get(SessionId('router-parent'));
  if (!agent?.ctx.tools.get('read', agent)) throw new Error('Standard preset did not expose the read tool');
  agent.followup(createUserMessage({ content: [{type:'text',text:'Router V3 fixture'}], source:{kind:'user'} }));
  await agent.whenIdle();
  // Child bookkeeping may finish after the parent loop reaches idle.
  let task;
  for (let attempt = 0; attempt < 100; attempt++) {
    task = (await ctx.modelRouter.describe(agent.id)).run.tasks[0];
    if (task && ['completed', 'failed'].includes(task.status)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!task || task.evidence?.length !== 5) throw new Error('Fixture evidence was not collected');
  const e = task.evidence;
  const reviews = [1,3].map(index => ({ acceptanceId: 'A1', category: 'capability', baseline: e[0].id, action: e[index].id, verification: e[index+1].id, explanation: 'Distinct diagnostic inspection confirms the same task-owned mismatch.' }));
  await ctx.modelRouter.review(agent, { taskId: task.id, executionId: task.executionId, reviews, unresolved: 'Mismatch remains after inspecting expected and actual values. Preserve user work.' }, new AbortController().signal);
  const reviewedTask = (await ctx.modelRouter.describe(agent.id)).run.tasks[0];
  const incomplete = { summary: 'Review finished; the mismatch remains unverified.', changes: [], remaining: ['Correct and verify the mismatch.'], acceptance: [{ id: 'A1', condition: reviewedTask.acceptance[0], status: 'unverified', method: 'reasoning', evidence: [], explanation: 'Execution ending does not demonstrate that actual equals expected.' }] };
  await ctx.modelRouter.taskAction(agent, { action: 'report', taskId: reviewedTask.id, executionId: reviewedTask.executionId, report: incomplete }, new AbortController().signal);
  await ctx.modelRouter.taskAction(agent, { action: 'report', report: incomplete }, new AbortController().signal);
  await ctx.sessionController.create({ sessionId: SessionId('router-other'), cwd: ${JSON.stringify(workspace)}, agentPreset: 'standard' });
  await ctx.sessionController.selectModel({ sessionId: SessionId('router-other'), provider: 'router-fixture', model: 'strong' });
  const beforeOff = await ctx.modelRouter.describe('router-parent');
  await ctx.modelRouter.command({ sessionId: 'router-parent', action: 'mode', mode: 'off', expectedRevision: beforeOff.control.revision, operationId: 'fixture-off' });
  if (ctx.agentDefaultModel.currentSelection().model !== 'strong') throw new Error('Restore changed global default');
  const restored = ctx.sessionProjections.stateOf(agent.session, 'modelSelection');
  if (restored.pending?.model !== 'original') throw new Error('Original model was not restored');
  const off = await ctx.modelRouter.describe('router-parent');
  await ctx.modelRouter.command({ sessionId: 'router-parent', action: 'mode', mode: 'auto', expectedRevision: off.control.revision, operationId: 'fixture-reenable' });
  ctx.sessionTitle.rename(agent.session, 'Router V3 parent');
  await ctx.sessionPersistence.flush();
  // Keep the seeded history, but start the settings UI with incomplete configuration.
  await ctx.settings.mutate('enhanced-model-router', [
    { op: 'set', path: ['enabled'], value: false },
    { op: 'set', path: ['models'], value: Object.fromEntries(['light', 'normal', 'strong'].map(tier => [tier, {provider:'',model:''}])) },
  ]);
  writeFileSync(${JSON.stringify(resolve(home, 'seed.json'))}, JSON.stringify(await ctx.modelRouter.describe(agent.id)));
}
`)
const overlay = resolve(home, 'web.patch.yml')
writeFileSync(overlay, `- id: session-log-deepseek
  config: { enabled: false }
- id: session-title-llm
  disabled: true
- id: directory-picker
  disabled: true
- insert:
    - id: router-fixture
      name: ${JSON.stringify(fixture)}
`)
const redact = text => text.replace(/token=[^\s"'&]+/g, 'token=[redacted]')
// The installer's optional provenance probes can leave LASTEXITCODE=1 even
// after successful validation. A wrapper preserves terminating failures while
// reporting normal PowerShell completion, followed by our installed-set checks.
const installRunner = resolve(home, 'install.ps1')
writeFileSync(installRunner, `param([string]$Repository, [string]$Checkout, [string]$Selection)
$ErrorActionPreference = 'Stop'
try {
  & (Join-Path $Repository 'scripts/migrate-to-enhanced-plugin.ps1') -DshCheckout $Checkout -Features $Selection -SkipBuild -SkipLauncherSystemIntegration
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`)
const install = features => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', installRunner, '-Repository', root, '-Checkout', dsh, '-Selection', features], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 120000 })
  writeFileSync(resolve(home, `install-${features.replaceAll(',', '-')}.log`), redact(result.stdout + result.stderr))
  assert.equal(result.status, 0, `Installation failed: ${home}`)
}
let child, browser, page, exited; let output = ''
try {
  install('model-router')
  const installed = name => existsSync(resolve(home, 'profiles/web/node_modules', `dsh-enhanced-${name}`))
  assert.ok(installed('model-router')); assert.ok(!installed('agent-team-monitor'))
  install('model-router,agent-team-monitor')
  assert.ok(installed('model-router')); assert.ok(installed('agent-team-monitor'))
  install('model-router')
  assert.ok(installed('model-router')); assert.ok(!installed('agent-team-monitor'))
  if (process.env.DSH_VERIFY_AGGREGATE === '1') {
    install('none')
    const packed = spawnSync(process.execPath, [process.env.npm_execpath, 'pack', '--ignore-scripts', '--json', '--pack-destination', home, root], { cwd: root, encoding: 'utf8', windowsHide: true })
    assert.equal(packed.status, 0, packed.stderr)
    const archive = resolve(home, JSON.parse(packed.stdout)[0].filename)
    const added = spawnSync(process.execPath, [...cliArgs, 'plugin', '--profile', 'web', 'add', archive, '--yes'], { cwd: dsh, env, encoding: 'utf8', windowsHide: true, timeout: 120000 })
    writeFileSync(resolve(home, 'install-aggregate.log'), redact(added.stdout + added.stderr))
    assert.equal(added.status, 0, 'Aggregate installation failed')
    assert.ok(!installed('model-router'))
    assert.ok(JSON.parse(readFileSync(resolve(home, 'profiles/web/package.json'), 'utf8')).dsh.profile.bundles.includes('dsh-enhanced-plugins'))
  }
  const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise(done => probe.close(done))
  child = spawn(process.execPath, [...cliArgs, 'web', '--patch', overlay, '--port', String(port), '--no-open'], { cwd: dsh, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); exited = once(child, 'exit')
  const url = await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`Startup timeout: ${redact(output)}`)), 90000)
    const accept = chunk => { output += chunk; const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/); if (match) { clearTimeout(timer); done(match[1]) } }
    child.stdout.on('data', accept); child.stderr.on('data', accept); child.once('error', reject); child.once('exit', code => { clearTimeout(timer); reject(new Error(`Host exit ${code}: ${redact(output)}`)) })
  })
  browser = await chromium.launch()
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', colorScheme: 'light' })
  const errors = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (['error', 'warning'].includes(message.type())) writeFileSync(resolve(home, 'browser.log'), redact(message.text()) + '\n', { flag: 'a' }) })
  await page.goto(url)
  const notice = page.getByRole('dialog', { name: 'Internal Testing Notice' })
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor({ timeout: 30000 })
  await notice.waitFor({ timeout: 5000 }).catch(() => {})
  if (await notice.isVisible()) await notice.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByText('Ungrouped', { exact: true }).click()
  await page.getByText('Router V3 parent', { exact: true }).or(page.getByText('workspace', { exact: true })).first().click({ timeout: 30000 })
  await page.getByText('Router V3 fixture', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByText('Model collaboration', { exact: true }).first().click()
  const enable = page.getByRole('switch', { name: 'Enable collaboration', exact: true })
  await enable.waitFor()
  assert.ok(await enable.isDisabled(), 'Missing role models must disable global enable')
  await page.getByText(/Configure these models before enabling collaboration:/).waitFor()
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForFunction(dark => document.body.hasAttribute('data-ds-dark-theme') === dark, scheme === 'dark')
    await page.screenshot({ path: resolve(home, `settings-incomplete-${scheme}.png`), fullPage: true })
  }
  // The global switch is off: no composer entry, menu or single-model lock remains.
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('button', { name: 'Model collaboration', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Model collaboration active', exact: true }).count(), 0)
  assert.ok(await page.getByRole('button', { name: /^Select model, current / }).isEnabled())
  await page.reload()
  await page.getByRole('button', { name: /^Select model, current / }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Model collaboration', exact: true }).count(), 0)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByText('Model collaboration', { exact: true }).first().click()
  for (const [tier, label] of [['light', 'Light · Search'], ['normal', 'Normal · Main and execution'], ['strong', 'Strong · Expert']]) {
    await page.getByRole('button', { name: `${label} · Primary model`, exact: true }).click()
    const modelPicker = page.getByRole('dialog', { name: 'Choose a configured model' })
    await modelPicker.getByRole('button', { name: `${tier} router-fixture / ${tier}`, exact: true }).click()
    await page.getByText('Settings saved.', { exact: true }).waitFor()
    if (tier !== 'strong') assert.ok(await enable.isDisabled(), 'Every missing role keeps collaboration disabled')
  }
  assert.ok(await enable.isEnabled(), 'All three configured roles allow enabling')
  await enable.click()
  await page.getByText('Settings saved.', { exact: true }).waitFor()
  assert.equal(await enable.getAttribute('aria-checked'), 'true')
  assert.equal(await page.getByRole('button', { name: /Add fallback/ }).count(), 0)
  await page.keyboard.press('Escape')

  const modelControl = page.getByRole('button', { name: 'Model collaboration', exact: true })
  const managedModel = page.getByRole('button', { name: 'Model collaboration active', exact: true })
  await managedModel.waitFor()
  assert.ok(await managedModel.isDisabled(), 'Managed single-model selector must be disabled')
  await managedModel.evaluate(element => element.click())
  assert.equal(await page.getByRole('menu').count(), 0, 'Disabled model status must not open a menu')
  await page.screenshot({ path: resolve(home, 'collaboration-locked.png'), fullPage: true })
  await modelControl.click()
  await page.screenshot({ path: resolve(home, 'collaboration-menu.png'), fullPage: true })
  await page.getByRole('menuitem', { name: 'Disable model collaboration', exact: true }).waitFor()
  assert.equal(await page.getByRole('menuitem', { name: 'Choose a configured model', exact: true }).count(), 0, 'Collaboration management does not contain the ordinary model selector')
  await page.getByRole('menuitem', { name: 'Disable model collaboration', exact: true }).click()
  const singleModel = page.getByRole('button', { name: /^Select model, current / })
  await singleModel.filter({ hasText: 'original' }).waitFor()
  assert.ok(await singleModel.isEnabled(), 'Turning collaboration off unlocks the model selector')
  await page.screenshot({ path: resolve(home, 'single-model.png'), fullPage: true })
  await singleModel.click()
  await page.getByRole('menu', { name: 'Model and reasoning effort' }).waitFor()
  await page.screenshot({ path: resolve(home, 'native-model-menu.png'), fullPage: true })
  await page.getByRole('menuitem', { name: /^Model/ }).click()
  const nativeGroup = page.getByRole('group', { name: 'router-fixture', exact: true })
  assert.equal(await nativeGroup.getByRole('menuitemradio', { name: 'original', exact: true }).getAttribute('aria-checked'), 'true')
  await page.screenshot({ path: resolve(home, 'native-model-list.png'), fullPage: true })
  await nativeGroup.getByRole('menuitemradio', { name: 'normal', exact: true }).click()
  await singleModel.filter({ hasText: 'normal' }).waitFor()
  await modelControl.click()
  await page.getByRole('menuitem', { name: 'Enable model collaboration', exact: true }).click()
  await managedModel.waitFor()
  assert.ok(await managedModel.isDisabled(), 'Re-enabling collaboration locks selection again')
  await page.reload()
  await managedModel.waitFor()
  assert.ok(await managedModel.isDisabled(), 'Reload preserves the disabled collaboration status')
  const settingsWindow = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' })
  await settingsWindow.goto(url)
  await settingsWindow.getByRole('button', { name: 'Settings', exact: true }).waitFor()
  const settingsNotice = settingsWindow.getByRole('dialog', { name: 'Internal Testing Notice' })
  if (await settingsNotice.isVisible()) await settingsNotice.getByRole('button', { name: 'Continue', exact: true }).click()
  await settingsWindow.getByRole('button', { name: 'Settings', exact: true }).click()
  await settingsWindow.getByText('Model collaboration', { exact: true }).first().click()
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForFunction(dark => document.body.hasAttribute('data-ds-dark-theme') === dark, scheme === 'dark')
    await modelControl.click()
    await page.getByRole('menuitem', { name: 'Disable model collaboration', exact: true }).waitFor()
    await settingsWindow.getByRole('switch', { name: 'Enable collaboration', exact: true }).click()
    await settingsWindow.getByText('Settings saved.', { exact: true }).waitFor()
    await modelControl.waitFor({ state: 'detached' })
    await managedModel.waitFor({ state: 'detached' })
    assert.equal(await page.getByRole('menu').count(), 0, 'Disabling globally removes an already-open collaboration menu')
    await singleModel.waitFor()
    assert.ok(await singleModel.isEnabled(), 'Disabling globally releases the native selector')
    await singleModel.click()
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    await nativeGroup.getByRole('menuitemradio', { name: 'light', exact: true }).click()
    await singleModel.filter({ hasText: 'light' }).waitFor()
    await page.screenshot({ path: resolve(home, `collaboration-disabled-${scheme}.png`), fullPage: true })
    await settingsWindow.getByRole('switch', { name: 'Enable collaboration', exact: true }).click()
    await settingsWindow.getByText('Settings saved.', { exact: true }).waitFor()
    await modelControl.waitFor()
    await managedModel.waitFor()
    assert.ok(await managedModel.isDisabled(), 'Re-enabling restores the existing session collaboration state')
    assert.equal(await page.getByRole('menu').count(), 0, 'Re-enabling must not reopen the old menu')
  }
  await settingsWindow.close()


  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForFunction(dark => document.body.hasAttribute('data-ds-dark-theme') === dark, scheme === 'dark')
    await page.getByRole('button', { name: 'Model collaboration', exact: true }).click()
    await page.getByRole('menuitem', { name: 'View collaboration details', exact: true }).click()
    const dialog = page.getByRole('region', { name: 'Model collaboration', exact: true })
    await dialog.getByText('A bounded implementation needs an executor and later verification.', { exact: false }).last().waitFor()
    await dialog.getByText('Acceptance incomplete', { exact: true }).last().waitFor()
    await dialog.getByText('Acceptance incomplete', { exact: true }).last().click()
    await dialog.getByText('Execution ending does not demonstrate that actual equals expected.', { exact: false }).last().waitFor()
    await page.screenshot({ path: resolve(home, `acceptance-${scheme}.png`), fullPage: true })
    await dialog.getByText('Result and evidence', { exact: true }).last().click()
    await dialog.getByText('Execution and upgrade history · 1', { exact: true }).last().waitFor()
    await dialog.getByText('Execution and upgrade history · 1', { exact: true }).last().click()
    await dialog.locator('details[open]').getByText('Capability upgrade', { exact: true }).first().waitFor()
    await dialog.getByText('Complete handoff', { exact: true }).click()
    await dialog.getByText('Tool evidence references', { exact: true }).click()
    await dialog.evaluate(element => { element.parentElement.scrollTop = 0 })
    await page.screenshot({ path: resolve(home, `conversation-${scheme}.png`), fullPage: true })
    await dialog.getByText('Complete handoff', { exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: resolve(home, `handoff-${scheme}.png`), fullPage: true })
    if (scheme === 'light') {
      await dialog.getByText('Routing and task controls', { exact: true }).click()
      await dialog.getByRole('button', { name: 'Fixed model', exact: true }).last().click()
      await page.getByRole('menuitem', { name: 'Strong · Expert · strong', exact: true }).click()
      await dialog.getByRole('button', { name: 'Fixed model', exact: true }).first().click()
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === 'Fixed model' && b.getAttribute('aria-pressed') === 'true'))
    }
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
  }
  await page.getByRole('button', { name: 'Model collaboration', exact: true }).click()
    await page.getByRole('menuitem', { name: 'View collaboration details', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Model collaboration', exact: true })
  await panel.getByText('Routing and task controls', { exact: true }).click()
  await panel.getByRole('button', { name: 'Pause', exact: true }).click()
  assert.equal(await panel.getByRole('spinbutton', { name: 'Additional tokens' }).count(), 0)
  assert.equal(await panel.getByText(/Estimated cost|Unpriced attempts/).count(), 0)
  assert.equal(await panel.getByText('Add request allowance', { exact: true }).count(), 0)
  await panel.getByText('Request attempts', { exact: true }).waitFor()
  await panel.getByText('Child executions', { exact: false }).waitFor()
  const counters = panel.locator('[class*="metricGrid"]')
  await counters.screenshot({ path: resolve(home, 'counters-without-caps.png') })
  const history = panel.locator('summary').filter({ hasText: /^Session run history$/ })
  await history.click()
  await panel.locator('summary').filter({ hasText: /^Filter history$/ }).click()
  await panel.getByRole('button', { name: 'Role', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Execution assistant', exact: true }).click()
  await panel.getByRole('textbox', { name: 'Model ID', exact: true }).fill('router-fixture/strong')
  await panel.getByText('No matching runs.', { exact: true }).waitFor()
  await panel.getByRole('textbox', { name: 'Model ID', exact: true }).fill('missing/model')
  await panel.getByText('No matching runs.', { exact: true }).waitFor()
  await panel.getByRole('textbox', { name: 'Model ID', exact: true }).fill('router-fixture/strong')
  await panel.getByText('No matching runs.', { exact: true }).waitFor()
  await page.context().setOffline(true)
  await panel.getByRole('alert').waitFor()
  await page.context().setOffline(false)
  await panel.getByRole('alert').waitFor({ state: 'hidden' })
  await panel.evaluate(element => { element.parentElement.scrollTop = element.parentElement.scrollHeight }); await page.screenshot({ path: resolve(home, 'history-dark.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await panel.evaluate(element => { element.parentElement.scrollTop = 0 })
  assert.ok(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Narrow collaboration panel overflow')
  await page.screenshot({ path: resolve(home, 'conversation-narrow.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await panel.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByText('Model collaboration', { exact: true }).first().click()
  await page.getByRole('heading', { name: 'Model collaboration', exact: true }).waitFor()
  await page.locator('[data-dsh-model-router-nav-icon] svg').waitFor()
  await page.getByRole('button', { name: 'Light · Search · Primary model', exact: true }).click()
  let picker = page.getByRole('dialog', { name: 'Choose a configured model' })
  await picker.getByRole('textbox', { name: 'Search models or providers' }).fill('light')
  await picker.getByRole('button', { name: /light router-fixture \/ light/ }).waitFor()
  await picker.getByText(/Some provider catalogs are unavailable:/).waitFor()
  await page.screenshot({ path: resolve(home, 'configured-model-picker.png'), fullPage: true })
  await picker.getByRole('button', { name: /light router-fixture \/ light/ }).click()
  await page.getByText('Advanced settings', { exact: true }).click()
  await page.getByText('Automatic routing rules', { exact: true }).click()
  await page.getByRole('spinbutton', { name: 'Concurrent children' }).fill('3')
  await page.getByRole('spinbutton', { name: 'Failed repair threshold' }).fill('3')
  await page.getByRole('checkbox', { name: 'Switch main model by planning phase' }).check()
  assert.equal(await page.getByRole('button', { name: /Add fallback/ }).count(), 0)
  await page.getByText('Settings saved.', { exact: true }).waitFor()
  assert.equal(await page.getByRole('spinbutton', { name: 'Observable request attempt limit' }).count(), 0)
  assert.equal(await page.getByRole('spinbutton', { name: 'Child execution limit' }).count(), 0)
  assert.equal(await page.getByText('Model prices', { exact: true }).count(), 0)
  assert.equal(await page.getByRole('checkbox', { name: 'Enable cumulative token limit' }).count(), 0)
  assert.equal(await page.getByRole('spinbutton', { name: 'Cumulative token limit', exact: true }).count(), 0)
  assert.ok(readFileSync(resolve(home, 'settings.yaml'), 'utf8').includes('maxConcurrentChildren: 3'))
  assert.ok(readFileSync(resolve(home, 'settings.yaml'), 'utf8').includes('repairFailuresBeforeUpgrade: 3'))
  assert.equal(await page.getByRole('button', { name: 'Save settings', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Restore inheritance', exact: true }).count(), 0)
  // Host rejects invalid input; preserve it while another client commits.
  await page.getByRole('spinbutton', { name: 'Concurrent children' }).fill('0')
  await page.getByText(/Automatic save failed/).waitFor()
  const other = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' })
  await other.goto(url)
  const otherNotice = other.getByRole('dialog', { name: 'Internal Testing Notice' })
  await other.getByRole('button', { name: 'Settings', exact: true }).waitFor()
  if (await otherNotice.isVisible()) await otherNotice.getByRole('button', { name: 'Continue', exact: true }).click()
  await other.getByRole('button', { name: 'Settings', exact: true }).click()
  await other.getByText('Model collaboration', { exact: true }).first().click()
  await other.getByText('Advanced settings', { exact: true }).click()
  await other.getByRole('spinbutton', { name: 'Concurrent children' }).fill('4')
  await other.getByText('Settings saved.', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Discard draft and load latest settings', exact: true }).waitFor()
  assert.equal(await page.getByRole('spinbutton', { name: 'Concurrent children' }).inputValue(), '0')
  await page.getByRole('button', { name: 'Discard draft and load latest settings', exact: true }).click()
  assert.equal(await page.getByRole('spinbutton', { name: 'Concurrent children' }).inputValue(), '4')
  await other.close()
  await page.getByText('Advanced settings', { exact: true }).click()
  await page.getByRole('heading', { name: 'Model collaboration', exact: true }).scrollIntoViewIfNeeded()
  for (const scheme of ['light', 'dark']) { await page.emulateMedia({ colorScheme: scheme }); await page.waitForFunction(dark => document.body.hasAttribute('data-ds-dark-theme') === dark, scheme === 'dark'); await page.screenshot({ path: resolve(home, `settings-${scheme}.png`), fullPage: true }) }
  await page.setViewportSize({ width: 1024, height: 900 }); await page.screenshot({ path: resolve(home, 'settings-compact.png'), fullPage: true })
  // The DSH settings shell itself has a desktop minimum width. Check our
  // actual mounted section at 320px without claiming the shell is mobile-ready.
  await page.setViewportSize({ width: 1440, height: 1000 })
  const settingsSection = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Model collaboration', exact: true }) }).last()
  await settingsSection.evaluate(element => { element.style.width = '320px' })
  assert.ok(await settingsSection.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Narrow settings content overflow')
  await page.getByRole('heading', { name: 'Model collaboration', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: resolve(home, 'settings-content-320.png'), fullPage: true })
  await settingsSection.evaluate(element => { element.style.removeProperty('width') })
  await page.getByText('General', { exact: true }).click()
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await page.getByRole('menuitem', { name: '中文', exact: true }).click()
  await page.getByText('多模型协作', { exact: true }).first().click()
  await page.getByRole('heading', { name: '多模型协作', exact: true }).waitFor()
  await page.getByText('高级设置', { exact: true }).click()
  assert.equal(await page.getByRole('checkbox', { name: '启用任务累计 token 限额' }).count(), 0)
  assert.equal(await page.getByRole('spinbutton', { name: '可观测请求尝试上限' }).count(), 0)
  assert.equal(await page.getByRole('spinbutton', { name: '子执行上限' }).count(), 0)
  assert.equal(await page.getByText('模型报价', { exact: true }).count(), 0)
  await page.getByText('高级设置', { exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: resolve(home, 'settings-zh.png'), fullPage: true })
  await page.keyboard.press('Escape')
  const chineseStatus = page.getByRole('button', { name: '多模型协作中', exact: true })
  await chineseStatus.waitFor()
  assert.ok(await chineseStatus.isDisabled(), 'Chinese status is also a disabled selector')
  assert.equal(await chineseStatus.getAttribute('aria-haspopup'), null, 'Managed status is not a dropdown trigger')
  assert.equal(await chineseStatus.locator('svg').count(), 0, 'Managed status has no dropdown arrow')
  await chineseStatus.locator('..').locator('..').screenshot({ path: resolve(home, 'collaboration-controls-zh.png') })
  await page.screenshot({ path: resolve(home, 'collaboration-locked-zh.png'), fullPage: true })
  assert.deepEqual(errors, [])
  writeFileSync(resolve(home, 'report.json'), JSON.stringify({ aggregate: process.env.DSH_VERIFY_AGGREGATE === '1', structuredAcceptance: true, delegationReason: true, selections: ['model-router', 'model-router,agent-team-monitor', 'model-router'], settings: true, autoSave: true, navigationIcon: true, separateControls: true, singleModelDisabledWhenManaged: true, offModeSelection: true, nativeModelMenu: true, managedReload: true, sessionOptIn: true, coldSelection: true, selectionGuard: true, remoteSelectionGuard: true, originalSelectionRestored: true, globalDefaultPreserved: true, catalogPartialFailure: true, conflictDraftPreserved: true, sidebar: true, nativeSelectsRemoved: true, retiredTokenAndPricingControlsAbsent: true, reconnect: true, historyEmpty: true, cumulativeCountLimitsRemoved: true, historyFilters: true, narrowConversation: 390, narrowSettingsContent: 320, locales: ['en', 'zh'], fixed: true, upgradeDetails: true, evidence: true, handoff: true, globalEnableControlsComposerVisibility: true, hiddenEntrySurvivesReload: true, globalDisableClosesMenuAndUnlocksModel: true, backupControlsRemoved: true, threeModelsRequired: true, systemThemes: ['light', 'dark'], errors }, null, 2))
  console.log(`Model router V3 Web verification passed: ${home}`)
} catch (error) {
  if (page) { await page.screenshot({ path: resolve(home, 'failure.png'), fullPage: true }).catch(() => {}); writeFileSync(resolve(home, 'failure.txt'), await page.locator('body').innerText().catch(() => 'unavailable')) }
  console.error(`Verification artifacts: ${home}`); throw error
} finally {
  await browser?.close(); if (child?.exitCode === null) child.kill(); if (exited) await exited
  writeFileSync(resolve(home, 'web.log'), redact(output))
}
