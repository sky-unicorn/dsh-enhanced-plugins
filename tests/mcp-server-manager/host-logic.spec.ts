/**
 * Unit tests for the pure host-side logic: server-definition projection,
 * secret masking, and the mcp-client config builder.
 */

import { describe, expect, it } from 'vitest'
import { maskServers, SECRET_MASK } from '../../src/mcp-server-manager/host/remote.ts'
import {
  Config, SERVER_NAME_PATTERN, toMcpClientConfig,
  type ServerDefinition, type StdioServerDefinition, type StreamableHttpServerDefinition,
} from '../../src/mcp-server-manager/host/schema.ts'

const stdio: StdioServerDefinition = {
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'server-everything'],
  env: { TOKEN: 'secret-value' },
  cwd: '',
  toolCallTimeoutMs: 60_000,
}

const http: StreamableHttpServerDefinition = {
  transport: 'streamable-http',
  url: 'https://example.test/mcp',
  headers: { Authorization: 'Bearer sk-live' },
  toolCallTimeoutMs: 60_000,
}

describe('maskServers', () => {
  it('masks stdio env values and keeps the keys visible', () => {
    const masked = maskServers({ demo: stdio })
    expect(masked['demo']?.transport).toBe('stdio')
    if (masked['demo']?.transport !== 'stdio') throw new Error('unreachable')
    expect(masked['demo'].env).toEqual({ TOKEN: SECRET_MASK })
    // The original is untouched (masking is a projection).
    expect(stdio.env['TOKEN']).toBe('secret-value')
  })

  it('masks http header values and keeps the keys visible', () => {
    const masked = maskServers({ demo: http })
    if (masked['demo']?.transport !== 'streamable-http') throw new Error('unreachable')
    expect(masked['demo'].headers).toEqual({ Authorization: SECRET_MASK })
  })

  it('keeps non-secret fields (command, url, args) readable', () => {
    const masked = maskServers({ a: stdio, b: http })
    if (masked['a']?.transport !== 'stdio') throw new Error('unreachable')
    if (masked['b']?.transport !== 'streamable-http') throw new Error('unreachable')
    expect(masked['a'].command).toBe('npx')
    expect(masked['a'].args).toEqual(['-y', 'server-everything'])
    expect(masked['b'].url).toBe(http.url)
  })
})

describe('toMcpClientConfig', () => {
  it('carries serverName and pins failOnStartupError false', () => {
    const config = toMcpClientConfig('demo', stdio)
    expect(config).toMatchObject({
      serverName: 'demo',
      failOnStartupError: false,
      transport: 'stdio',
      command: 'npx',
    })
  })

  it('spreads the definition so changed fields restart the connection', () => {
    const config = toMcpClientConfig('demo', http)
    expect(config).toMatchObject({ url: http.url, transport: 'streamable-http' })
  })
})

describe('Config schema', () => {
  it('accepts a mixed server record and fills defaults', () => {
    const resolved = Config({
      servers: {
        a: { transport: 'stdio', command: 'npx' },
        b: { transport: 'streamable-http', url: 'https://x.test' },
      },
    }) as { servers: Record<string, ServerDefinition> }
    const a = resolved.servers['a']
    if (a?.transport !== 'stdio') throw new Error('unreachable')
    expect(a.args).toEqual([])
    expect(a.env).toEqual({})
    expect(a.toolCallTimeoutMs).toBe(60_000)
    const b = resolved.servers['b']
    if (b?.transport !== 'streamable-http') throw new Error('unreachable')
    expect(b.headers).toEqual({})
  })

  it('refuses an invalid serverName key', () => {
    expect(() => Config({ servers: { 'bad name!': { transport: 'stdio', command: 'x' } } })).toThrow()
  })
})

describe('SERVER_NAME_PATTERN', () => {
  it('accepts letters, digits, underscore, dash up to 32', () => {
    expect(SERVER_NAME_PATTERN.test('a')).toBe(true)
    expect(SERVER_NAME_PATTERN.test('My-Server_2')).toBe(true)
    expect(SERVER_NAME_PATTERN.test('a'.repeat(32))).toBe(true)
  })

  it('rejects spaces, dots, CJK, and over-length names', () => {
    expect(SERVER_NAME_PATTERN.test('bad name')).toBe(false)
    expect(SERVER_NAME_PATTERN.test('a.b')).toBe(false)
    expect(SERVER_NAME_PATTERN.test('服务器')).toBe(false)
    expect(SERVER_NAME_PATTERN.test('a'.repeat(33))).toBe(false)
  })
})
