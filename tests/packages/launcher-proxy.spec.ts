import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../..', import.meta.url))
const source = resolve(root, 'packages/windows-launcher/src')
const helper = resolve(source, 'DSH-Launcher.GitProxy.ps1')
const ps = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']
const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`
const cleanEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !/^(https?_proxy|all_proxy|no_proxy)$/i.test(name)))

describe.runIf(process.platform === 'win32')('Windows launch proxy fallback', () => {
  it('preserves explicit policy and resolves supported static settings without persisting them', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'dsh-launch-proxy-'))
    try {
      const file = resolve(directory, 'cases.ps1')
      writeFileSync(file, `
$ErrorActionPreference = 'Stop'
. ${quote(helper)}
$homeDir = ${quote(directory)}
$envMap = @{ DSH_HOME = $homeDir; NO_PROXY = 'internal.example' }
$settings = [pscustomobject]@{ ProxyEnable = 1; ProxyServer = '127.0.0.1:7890' }
$provider = { $settings }
$cases = @{}
$cases.default = Get-DshSystemProxyEnvironment -Environment $envMap -SettingsProvider $provider
$cases.original = $envMap.Clone()
foreach ($key in @('HTTP_PROXY','https_proxy','ALL_PROXY')) {
  $explicit = $envMap.Clone(); $explicit[$key] = 'socks5://explicit.invalid:9'
  $cases[$key] = Get-DshSystemProxyEnvironment -Environment $explicit -SettingsProvider { throw 'should not read settings' }
}
$path = Join-Path $homeDir '.env'
[IO.File]::WriteAllText($path, '# HTTPS_PROXY=http://comment.invalid' + [Environment]::NewLine + 'export HTTPS_PROXY=""')
$cases.home = Get-DshSystemProxyEnvironment -Environment $envMap -SettingsProvider { throw 'should not read settings' }
[IO.File]::WriteAllText($path, 'NO_PROXY=internal.example')
$cases.bypass = Get-DshSystemProxyEnvironment -Environment $envMap -SettingsProvider $provider
Remove-Item -LiteralPath $path
$settings.ProxyServer = 'http=127.0.0.1:7891;https=http://127.0.0.1:7892'
$cases.split = Get-DshSystemProxyEnvironment -Environment $envMap -SettingsProvider $provider
$settings.ProxyEnable = 0
$cases.disabled = Get-DshSystemProxyEnvironment -Environment $envMap -SettingsProvider $provider
$settings.ProxyEnable = 1
foreach ($value in @('https=127.0.0.1:7890','socks=127.0.0.1:1080','socks5://127.0.0.1:1080','http://host.invalid/path')) {
  $settings.ProxyServer = $value
  $cases[$value] = Get-DshSystemProxyEnvironment -Environment $envMap -SettingsProvider $provider
}
$settings | Add-Member AutoConfigURL 'https://pac.invalid/proxy.pac'
$cases.pac = Get-DshSystemProxyEnvironment -Environment $envMap -SettingsProvider $provider
$cases.unavailable = Get-DshSystemProxyEnvironment -Environment $envMap -SettingsProvider { throw 'private-error-detail' }
$cases | ConvertTo-Json -Depth 6 -Compress
`)
      const result = spawnSync('powershell.exe', [...ps, file], { encoding: 'utf8', windowsHide: true })
      expect(result.status, result.stderr).toBe(0)
      const cases = JSON.parse(result.stdout)
      expect(cases.default).toEqual({ reason: 'windows-system', environment: {
        HTTP_PROXY: 'http://127.0.0.1:7890/', HTTPS_PROXY: 'http://127.0.0.1:7890/',
      } })
      expect(cases.original).toEqual({ DSH_HOME: directory, NO_PROXY: 'internal.example' })
      for (const key of ['HTTP_PROXY', 'https_proxy', 'ALL_PROXY']) expect(cases[key]).toEqual({ reason: 'explicit-environment', environment: {} })
      expect(cases.home).toEqual({ reason: 'explicit-home-env', environment: {} })
      expect(cases.bypass).toEqual(cases.default)
      expect(cases.split.environment).toEqual({ HTTP_PROXY: 'http://127.0.0.1:7891/', HTTPS_PROXY: 'http://127.0.0.1:7892/' })
      expect(cases.disabled).toEqual({ reason: 'none', environment: {} })
      for (const key of ['https=127.0.0.1:7890', 'socks=127.0.0.1:1080', 'socks5://127.0.0.1:1080', 'http://host.invalid/path']) {
        expect(cases[key]).toEqual({ reason: 'unsupported-policy', environment: {} })
      }
      expect(cases.pac).toEqual({ reason: 'automatic-policy', environment: {} })
      expect(cases.unavailable).toEqual({ reason: 'unavailable', environment: {} })
      expect(result.stdout + result.stderr).not.toContain('private-error-detail')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('passes fallback through the real command runner into DSH fetch and keeps loopback direct', async () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'dsh-launch-proxy-wire-'))
    const tunnels: string[] = []
    const proxy = createServer((request, response) => {
      const target = new URL(request.url ?? '')
      tunnels.push(`${target.hostname}:${target.port || '80'}`)
      response.setHeader('content-type', 'application/json')
      response.end('{"proxied":true}')
    })
    proxy.on('connect', (request, socket) => {
      tunnels.push(request.url ?? '')
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 15\r\nConnection: close\r\n\r\n{"proxied":true}'))
    })
    proxy.listen(0, '127.0.0.1')
    await once(proxy, 'listening')
    const port = (proxy.address() as { port: number }).port
    const direct = createServer((_req, res) => res.end('direct'))
    direct.listen(0, '127.0.0.1')
    await once(direct, 'listening')
    const directPort = (direct.address() as { port: number }).port
    try {
      const runner = resolve(directory, 'DSH-Launcher.Command.ps1')
      writeFileSync(runner, '\uFEFF' + readFileSync(resolve(source, 'DSH-Launcher.Command.ps1'), 'utf8'))
      // Stub only OS discovery; the shipped command engine, child environment,
      // DSH dispatcher, TCP tunnel and fetch remain real.
      writeFileSync(resolve(directory, 'DSH-Launcher.GitProxy.ps1'), readFileSync(helper, 'utf8') + `
function Get-ItemProperty { param($LiteralPath, $ErrorAction)
  return [pscustomobject]@{ ProxyEnable = 1; ProxyServer = '127.0.0.1:${port}' }
}
`)
      const script = resolve(directory, 'fetch.mjs')
      const dshProxy = resolve(root, '../deepseek-harness/packages/util/http-proxy/lib/index.js')
      writeFileSync(script, `
import assert from 'node:assert/strict';
import { installProxyFromEnvironment } from ${JSON.stringify(pathToFileURL(dshProxy).href)};
const dispose = await installProxyFromEnvironment({ get: name => process.env[name] === undefined ? undefined : { value: process.env[name] } }, () => {});
try {
  const response = await fetch('http://launcher-market.invalid/catalog', { signal: AbortSignal.timeout(5000) });
  assert.deepEqual(await response.json(), { proxied: true });
  assert.equal(await (await fetch('http://127.0.0.1:${directPort}', { signal: AbortSignal.timeout(5000) })).text(), 'direct');
  console.log('DSH_PROXY_FETCH_OK');
} finally { await dispose(); }
`)
      const shim = resolve(directory, 'dsh.ps1')
      writeFileSync(shim, `& ${quote(process.execPath)} ${quote(script)}\nexit $LASTEXITCODE\n`)
      const home = resolve(directory, 'home'); mkdirSync(home)
      const request = resolve(directory, 'request.json')
      const log = resolve(directory, 'launch.log')
      writeFileSync(request, JSON.stringify({ mode: 'web', requestId: 'proxy-fixture', workingDirectory: directory,
        dshCommand: shim, logPath: log, port: 3080, noOpen: true, accessPath: '' }))
      const child = spawn('powershell.exe', [...ps, runner, '-RequestPath', request], {
        env: { ...cleanEnv(), DSH_HOME: home }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
      let errors = ''; child.stderr.on('data', data => { errors += data.toString() })
      child.stdout.resume()
      const [code] = await once(child, 'exit')
      expect(code, errors + readFileSync(log, 'utf8')).toBe(0)
      expect(tunnels).toEqual(['launcher-market.invalid:80'])
      const output = readFileSync(log, 'utf8')
      expect(output).toContain('DSH_PROXY_FETCH_OK')
      expect(output).toContain('using the Windows HTTP/HTTPS proxy')
      expect(output).not.toContain(`127.0.0.1:${port}`)
    } finally {
      proxy.close(); direct.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 20_000)
})
