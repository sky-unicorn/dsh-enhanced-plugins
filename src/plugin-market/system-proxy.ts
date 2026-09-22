import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PROXY_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'] as const
const PROXY_ENV_PATTERN = /^(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)$/iu
const SETTINGS_PATH = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

interface WindowsProxySettings {
  readonly enabled?: number
  readonly server?: string
  readonly autoDetect?: number
  readonly autoConfigUrl?: string
}

type SavedEnvironment = ReadonlyArray<readonly [string, string | undefined]>

function hasExplicitProxyEnvironment(): boolean {
  return Object.keys(process.env).some(name => PROXY_ENV_PATTERN.test(name))
}

function hasHomeProxyEnvironment(): boolean {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  try {
    return /^(?:\s*export\s+)?(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)\s*(?:=|:\s)/imu
      .test(readFileSync(join(home, '.env'), 'utf8'))
  } catch {
    return false
  }
}

function readWindowsProxySettings(): WindowsProxySettings | undefined {
  if (process.platform !== 'win32') return undefined
  try {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$settings = Get-ItemProperty -LiteralPath '${SETTINGS_PATH}'`,
      '[pscustomobject]@{ enabled = $settings.ProxyEnable; server = [string]$settings.ProxyServer; '
        + 'autoDetect = $settings.AutoDetect; autoConfigUrl = [string]$settings.AutoConfigURL } | ConvertTo-Json -Compress',
    ].join('; ')
    const raw = execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], { encoding: 'utf8', timeout: 2_000, windowsHide: true }).trim()
    if (raw === '') return undefined
    return JSON.parse(raw) as WindowsProxySettings
  } catch {
    return undefined
  }
}

function normalizeProxy(value: string): string | undefined {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//iu.test(value) ? value : `http://${value}`
  try {
    const url = new URL(candidate)
    if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search !== '' || url.hash !== ''
      || url.hostname === '') return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

function resolveWindowsProxy(): Record<'HTTP_PROXY' | 'HTTPS_PROXY', string> | undefined {
  if (process.platform !== 'win32' || hasExplicitProxyEnvironment() || hasHomeProxyEnvironment()) return undefined
  const settings = readWindowsProxySettings()
  const autoConfigUrl = settings?.autoConfigUrl?.trim()
  if (settings === undefined || settings.enabled !== 1 || settings.autoDetect === 1
    || autoConfigUrl !== undefined && autoConfigUrl !== '') return undefined
  const value = settings.server?.trim() ?? ''
  if (value === '') return undefined
  const mapped = new Map<string, string>()
  if (/^(?:http|https|ftp|socks)\s*=/iu.test(value)) {
    for (const entry of value.split(';')) {
      const match = /^\s*(http|https)\s*=\s*(.+?)\s*$/iu.exec(entry)
      const scheme = match?.[1]
      const address = match?.[2]
      if (scheme !== undefined && address !== undefined) mapped.set(scheme.toLowerCase(), address)
    }
  } else {
    mapped.set('http', value)
    mapped.set('https', value)
  }
  const http = normalizeProxy(mapped.get('http') ?? '')
  const https = normalizeProxy(mapped.get('https') ?? '')
  if (http === undefined || https === undefined) return undefined
  return { HTTP_PROXY: http, HTTPS_PROXY: https }
}

/** Run one package installation with a process-local Windows proxy fallback. */
export async function withWindowsInstallProxy<T>(operation: () => Promise<T>): Promise<T> {
  const proxy = resolveWindowsProxy()
  if (proxy === undefined) return operation()
  const saved: SavedEnvironment = PROXY_NAMES.map(name => [name, process.env[name]])
  for (const [name, value] of Object.entries(proxy)) process.env[name] = value
  try {
    return await operation()
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}
