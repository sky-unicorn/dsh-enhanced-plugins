/** Real installed Web + local SSE model: edit, replay, repeated edit, and both system color schemes. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

if (process.platform !== 'win32') throw new Error('This installer/browser gate requires Windows PowerShell 5.1.')
const root = fileURLToPath(new URL('..', import.meta.url))
const dsh = resolve(process.env.DSH_VERIFY_CHECKOUT ?? resolve(root, '../deepseek-harness'))
const requireDsh = createRequire(resolve(dsh, 'apps/web/package.json'))
const { chromium } = requireDsh('playwright')
const scratch = resolve(root, '.verify-dsh-home')
mkdirSync(scratch, { recursive: true })
const home = mkdtempSync(resolve(scratch, 'edit-web-620-'))
const workspace = resolve(home, 'workspace')
mkdirSync(workspace)
// Keep project Skill discovery inside this fixture instead of the enclosing plugin repository.
const initialized = spawnSync('git', ['init', '--quiet', workspace], { encoding: 'utf8', windowsHide: true })
assert.equal(initialized.status, 0, `Cannot initialize the fixture workspace: ${initialized.stderr}`)
writeFileSync(resolve(workspace, 'preview.md'), '# RC2_FILE_PREVIEW\n\nLocal reference preview fixture.\n')
const skillDirectory = resolve(workspace, '.agents/skills/compat-preview')
mkdirSync(skillDirectory, { recursive: true })
writeFileSync(resolve(skillDirectory, 'SKILL.md'), '---\nname: compat-preview\ndescription: Local compatibility preview fixture\n---\n\n# RC2_SKILL_PREVIEW\n\nReply briefly.\n')
const requests = []
const model = createServer(async (request, response) => {
  try {
    const parts = []
    for await (const part of request) parts.push(part)
    const payload = JSON.parse(Buffer.concat(parts).toString('utf8'))
    requests.push(payload)
    const base = { id: `fixture-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: payload.model }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: `COMPAT_REPLY_${requests.length}` }, finish_reason: null }] })}\n\n`)
    response.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`)
  } catch { response.writeHead(400); response.end('Invalid fixture request') }
})
model.listen(0, '127.0.0.1')
await once(model, 'listening')
const env = { ...process.env, DSH_HOME: home, DEEPSEEK_HARNESS_LAUNCHER_HOME: resolve(home, 'launcher'),
  DSH_TELEMETRY_MODE: 'DISABLED', DEEPSEEK_API_KEY: 'local-fixture',
  DEEPSEEK_BASE_URL: `http://127.0.0.1:${model.address().port}/v1` }
const overlay = resolve(home, 'browser.patch.yml')
writeFileSync(overlay, `- id: session-title-llm\n  disabled: true\n- id: directory-picker\n  disabled: true\n- insert:\n    - id: fixture-directory-host\n      name: '@deepseek-ai/dsh-host-directory-picker-browse'\n    - id: fixture-directory-client\n      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'\n`)
let child, browser, page, exit
let output = ''
const redact = text => text.replace(/token=[^\s"'&]+/g, 'token=[redacted]')
try {
  const installed = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', resolve(root, 'scripts/migrate-to-enhanced-plugin.ps1'), '-DshCheckout', dsh,
    '-Features', 'edit-last-message', '-SkipBuild', '-SkipLauncherSystemIntegration'],
  { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 120_000 })
  writeFileSync(resolve(home, 'install.log'), redact(`${installed.stdout}\n${installed.stderr}`))
  assert.equal(installed.status, 0, `Install failed; see ${home}/install.log`)
  const portProbe = createServer()
  portProbe.listen(0, '127.0.0.1'); await once(portProbe, 'listening')
  const port = portProbe.address().port
  await new Promise(done => portProbe.close(done))
  child = spawn(process.execPath, ['--import', pathToFileURL(resolve(dsh, 'node_modules/tsx/dist/esm/index.mjs')).href,
    resolve(dsh, 'apps/cli/src/bin.ts'), 'web', '--patch', overlay, '--port', String(port), '--no-open'],
  { cwd: dsh, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  exit = once(child, 'exit')
  const url = await new Promise((done, reject) => {
    const timeout = setTimeout(() => reject(new Error('Web startup timed out')), 90_000)
    const accept = chunk => {
      output += chunk.toString()
      const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)
      if (match) { clearTimeout(timeout); done(match[1]) }
    }
    child.stdout.on('data', accept); child.stderr.on('data', accept)
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Web exited ${code}`)) })
  })
  browser = await chromium.launch()
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', colorScheme: 'light' })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(url)
  const notice = page.getByRole('dialog', { name: 'Internal Testing Notice' })
  await notice.waitFor({ timeout: 30_000 })
  await notice.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('textbox', { name: 'Choose workspace' }).click()
  const picker = page.getByRole('dialog', { name: 'Select Workspace Directory' })
  await picker.getByRole('button', { name: 'Edit path' }).click()
  await picker.getByRole('textbox', { name: 'Edit path' }).fill(workspace)
  await picker.getByRole('textbox', { name: 'Edit path' }).press('Enter')
  await picker.getByRole('button', { name: 'Open', exact: true }).click()
  const composer = page.locator('[data-composer-input][contenteditable="true"]')
  const original = '/compat-preview ORIGINAL_COMPAT_PROMPT @preview.md'
  await composer.fill(original)
  // A reference candidate may own Enter while its async menu is open.
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await page.getByText('COMPAT_REPLY_1', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
  const transcript = page.locator('[data-chat-flow-key]')
  const preview = page.locator('[data-document-markdown]')
  await transcript.locator('button[data-ref-chip="file"]').click()
  await preview.getByText('RC2_FILE_PREVIEW', { exact: true }).waitFor()
  await transcript.locator('button[data-ref-chip="skill"]').click()
  await preview.getByText('RC2_SKILL_PREVIEW', { exact: true }).waitFor()
  assert.equal(requests.length, 1, 'preview submitted another model request')
  await page.reload()
  await transcript.locator('button[data-ref-chip="skill"]').waitFor()
  await transcript.locator('button[data-ref-chip="skill"]').click()
  await preview.getByText('RC2_SKILL_PREVIEW', { exact: true }).waitFor()
  for (const [index, scheme] of ['light', 'dark'].entries()) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForFunction(dark => document.body.hasAttribute('data-ds-dark-theme') === dark, scheme === 'dark')
    await page.getByRole('button', { name: 'Edit last message', exact: true }).click()
    const editor = page.getByRole('textbox', { name: 'Edit last message', exact: true })
    await editor.fill(`REVISED_COMPAT_${index + 1} @preview.md`)
    await page.screenshot({ path: resolve(home, `editor-${scheme}.png`), fullPage: true, animations: 'disabled' })
    await page.getByRole('button', { name: 'Save and resend', exact: true }).click()
    await page.getByText(`COMPAT_REPLY_${index + 2}`, { exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    await page.locator('[data-chat-flow-key]').getByText(original, { exact: true }).waitFor({ state: 'hidden' })
    const messages = JSON.stringify(requests.at(-1).messages)
    assert.ok(messages.includes(`REVISED_COMPAT_${index + 1}`))
    assert.ok(!messages.includes('ORIGINAL_COMPAT_PROMPT'), 'old input survived the rewind')
    if (index > 0) assert.ok(!messages.includes('REVISED_COMPAT_1'), 'earlier edit survived the rewind')
    await page.reload()
    await page.getByRole('button', { name: 'Edit last message', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    await transcript.locator('[data-edit-cut-start] button[data-ref-chip="file"]').filter({ visible: true }).click()
    await preview.getByText('RC2_FILE_PREVIEW', { exact: true }).waitFor()
    await page.screenshot({ path: resolve(home, `reloaded-${scheme}.png`), fullPage: true, animations: 'disabled' })
  }
  await page.locator('input[type="file"]').setInputFiles({ name: 'compat.txt', mimeType: 'text/plain', buffer: Buffer.from('local fixture attachment') })
  await page.getByRole('group', { name: 'Pending attachments' }).locator('svg[viewBox="0 0 28 28"]').waitFor()
  await composer.fill('ATTACHMENT_COMPAT_PROMPT')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await page.getByText('COMPAT_REPLY_4', { exact: true }).waitFor({ timeout: 30_000 })
  await page.locator('[data-chat-flow-key]').getByTitle('compat.txt', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Edit last message', exact: true }).waitFor({ state: 'hidden' })
  for (const scheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForFunction(dark => document.body.hasAttribute('data-ds-dark-theme') === dark, scheme === 'dark')
    await page.screenshot({ path: resolve(home, `attachment-${scheme}.png`), fullPage: true, animations: 'disabled' })
  }
  assert.deepEqual(errors, [])
  writeFileSync(resolve(home, 'report.json'), JSON.stringify({ requests: requests.length, repeatedEdits: true, reload: true, attachment: true,
    sentFilePreview: true, sentSkillPreview: true, editedFilePreview: true, schemes: ['light', 'dark'], pageErrors: errors }, null, 2))
  console.log(`Real Web edit verification passed: ${home}`)
} catch (error) {
  if (page) {
    await page.screenshot({ path: resolve(home, 'failure.png'), fullPage: true, animations: 'disabled' }).catch(() => {})
    writeFileSync(resolve(home, 'failure.txt'), await page.locator('body').innerText().catch(() => 'page unavailable'))
  }
  throw error
} finally {
  await browser?.close()
  if (child?.exitCode === null) child.kill()
  if (exit) await exit
  model.closeAllConnections()
  await new Promise(done => model.close(done))
  writeFileSync(resolve(home, 'web.log'), redact(output))
}
