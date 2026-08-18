/** Host-side import discovery, de-duplication, and format-audit tests. */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  discoverMcpImports, planMcpImports, sanitizeServerName,
  type McpImportCandidate, type McpImportDiscovery,
} from '../../src/mcp-server-manager/host/importers.ts'
import type { ServerDefinition } from '../../src/mcp-server-manager/host/schema.ts'
import { assertMcpConfigValid, inspectMcpConfig } from '../../src/mcp-server-manager/host/validation.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixtureDirectories(): Promise<{ home: string; project: string; nested: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-manager-'))
  temporaryDirectories.push(root)
  const home = join(root, 'home')
  const project = join(root, 'project')
  const nested = join(project, 'packages', 'app')
  await Promise.all([mkdir(home, { recursive: true }), mkdir(nested, { recursive: true })])
  return { home, project, nested }
}

function stdio(command: string): ServerDefinition {
  return {
    transport: 'stdio',
    command,
    args: [],
    env: {},
    cwd: '',
    toolCallTimeoutMs: 60_000,
  }
}

describe('Claude Code discovery', () => {
  it('applies local > project > user precedence and expands Host-side variables', async () => {
    const { home, project, nested } = await fixtureDirectories()
    await writeFile(join(home, '.claude.json'), JSON.stringify({
      mcpServers: {
        shared: { command: 'user-command' },
        userOnly: { command: 'user-only' },
      },
      projects: {
        [project]: {
          mcpServers: {
            shared: {
              command: 'local-${TOKEN}',
              args: ['${CLAUDE_PROJECT_DIR}', '${MISSING:-fallback}'],
              env: { TOKEN: '${TOKEN}' },
            },
          },
        },
      },
    }), 'utf8')
    await writeFile(join(project, '.mcp.json'), JSON.stringify({
      mcpServers: {
        shared: { command: 'project-command' },
        remote: {
          type: 'http',
          url: 'https://example.test/${ENDPOINT:-mcp}',
          headers: { Authorization: 'Bearer ${TOKEN}' },
          timeout: 2_500,
        },
        legacy: { type: 'sse', url: 'https://example.test/sse' },
      },
    }), 'utf8')

    const discovery = await discoverMcpImports({
      homeDir: home,
      projectRoots: [nested],
      env: { TOKEN: 'host-secret' },
      sources: ['claude-code'],
    })

    expect(discovery.found).toEqual({ 'claude-code': true, codex: false })
    expect(discovery.skipped).toBe(1)
    expect(discovery.issues).toContainEqual({
      source: 'claude-code', scope: 'project', serverName: 'legacy', code: 'unsupported-transport',
    })
    const byName = Object.fromEntries(discovery.candidates.map(candidate => [candidate.serverName, candidate]))
    expect(Object.keys(byName).sort()).toEqual(['remote', 'shared', 'userOnly'])
    expect(byName['shared']?.scope).toBe('local')
    expect(byName['shared']?.definition).toMatchObject({
      transport: 'stdio',
      command: 'local-host-secret',
      args: [project, 'fallback'],
      env: { TOKEN: 'host-secret' },
    })
    expect(byName['remote']?.definition).toMatchObject({
      transport: 'streamable-http',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer host-secret' },
      toolCallTimeoutMs: 2_500,
    })
  })
})

describe('Codex discovery', () => {
  it('applies project overrides, resolves environment references, and reports skipped options', async () => {
    const { home, project, nested } = await fixtureDirectories()
    const codexHome = join(home, '.codex')
    await mkdir(codexHome, { recursive: true })
    await writeFile(join(codexHome, 'config.toml'), `
[mcp_servers.shared]
command = "npx"
args = ["-y"]
env_vars = ["TOKEN"]

[mcp_servers.remote]
url = "https://example.test/mcp"
bearer_token_env_var = "TOKEN"
env_http_headers = { "X-Api-Key" = "TOKEN" }

[mcp_servers.disabled]
command = "ignored"
enabled = false
`, 'utf8')
    await mkdir(join(project, '.codex'), { recursive: true })
    await writeFile(join(project, '.codex', 'config.toml'), `
[mcp_servers.shared]
command = "node"
args = ["server.mjs"]
env_vars = ["TOKEN"]
tool_timeout_sec = 12
enabled_tools = ["search"]
`, 'utf8')

    const discovery = await discoverMcpImports({
      homeDir: home,
      projectRoots: [nested],
      env: { TOKEN: 'host-token' },
      sources: ['codex'],
    })

    expect(discovery.found).toEqual({ 'claude-code': false, codex: true })
    expect(discovery.skipped).toBe(1)
    const byName = Object.fromEntries(discovery.candidates.map(candidate => [candidate.serverName, candidate]))
    expect(byName['shared']?.scope).toBe('project')
    expect(byName['shared']?.definition).toMatchObject({
      transport: 'stdio', command: 'node', args: ['server.mjs'], env: { TOKEN: 'host-token' },
      toolCallTimeoutMs: 12_000,
    })
    expect(byName['remote']?.definition).toMatchObject({
      transport: 'streamable-http',
      headers: { Authorization: 'Bearer host-token', 'X-Api-Key': 'host-token' },
    })
    expect(discovery.issues).toContainEqual({
      source: 'codex', scope: 'user', serverName: 'disabled', code: 'disabled',
    })
    expect(discovery.issues).toContainEqual({
      source: 'codex', scope: 'project', serverName: 'shared', code: 'ignored-options',
    })
  })

  it('treats a general Codex config with no mcp_servers table as valid and empty', async () => {
    const { home, project, nested } = await fixtureDirectories()
    const codexHome = join(home, '.codex')
    await mkdir(codexHome, { recursive: true })
    await writeFile(join(codexHome, 'config.toml'), 'model = "gpt-5"\n', 'utf8')
    await mkdir(join(project, '.codex'), { recursive: true })
    await writeFile(join(project, '.codex', 'config.toml'), 'model_reasoning_effort = "high"\n', 'utf8')

    const discovery = await discoverMcpImports({
      homeDir: home,
      projectRoots: [nested],
      env: {},
      sources: ['codex'],
    })

    expect(discovery.found.codex).toBe(true)
    expect(discovery.candidates).toEqual([])
    expect(discovery.issues).toEqual([])
  })
})

describe('import planning', () => {
  it('deduplicates exact definitions and lets current DSH names win', () => {
    const candidates: McpImportCandidate[] = [
      { source: 'claude-code', scope: 'user', serverName: 'same-config', definition: stdio('npx') },
      { source: 'codex', scope: 'user', serverName: 'existing', definition: stdio('node') },
      { source: 'codex', scope: 'user', serverName: 'bad name', definition: stdio('bun') },
    ]
    const discovery: McpImportDiscovery = {
      candidates,
      found: { 'claude-code': true, codex: true },
      skipped: 0,
      issues: [{
        source: 'codex', scope: 'user', serverName: 'bad\nname', code: 'server-invalid',
      }],
    }

    const planned = planMcpImports({ existing: stdio('npx') }, discovery)

    expect(planned.summary).toMatchObject({ imported: 1, duplicates: 2, renamed: 1 })
    expect(planned.summary.importedNames).toEqual(['bad-name'])
    expect(planned.summary.issues[0]?.serverName).toBe('bad�name')
    expect(Object.keys(planned.additions)).toEqual(['bad-name'])
    expect(planned.additions['existing']).toBeUndefined()
  })

  it('normalizes arbitrary external names to the DSH server-name contract', () => {
    expect(sanitizeServerName('my.server name')).toBe('my-server-name')
    expect(sanitizeServerName('***')).toBe('imported-mcp')
    expect(sanitizeServerName('a'.repeat(40))).toBe('a'.repeat(32))
  })

  it('uses suffixes only for collisions between newly imported entries', () => {
    const discovery: McpImportDiscovery = {
      candidates: [
        { source: 'claude-code', scope: 'user', serverName: 'shared', definition: stdio('node') },
        { source: 'codex', scope: 'user', serverName: 'shared', definition: stdio('bun') },
      ],
      found: { 'claude-code': true, codex: true },
      skipped: 0,
      issues: [],
    }

    const planned = planMcpImports({}, discovery)

    expect(planned.summary).toMatchObject({ imported: 2, duplicates: 0, renamed: 1 })
    expect(planned.summary.importedNames).toEqual(['shared', 'shared-2'])
  })
})

describe('format validation', () => {
  it('reports unsafe URLs and header names without including field values', () => {
    const report = inspectMcpConfig({
      servers: {
        remote: {
          transport: 'streamable-http',
          url: 'ftp://user:secret@example.test/mcp',
          headers: { 'Bad Header': 'secret-value' },
          toolCallTimeoutMs: 60_000,
        },
      },
    })
    expect(report.valid).toBe(false)
    expect(report.issues).toEqual(expect.arrayContaining([
      { serverName: 'remote', field: 'url', code: 'invalid-url', severity: 'error' },
      { serverName: 'remote', field: 'headers.Bad Header', code: 'invalid-header-name', severity: 'error' },
    ]))
    expect(JSON.stringify(report)).not.toContain('secret-value')
    expect(() => assertMcpConfigValid({
      servers: {
        remote: {
          transport: 'streamable-http',
          url: 'ftp://user:secret@example.test/mcp',
          headers: {},
          toolCallTimeoutMs: 60_000,
        },
      },
    })).toThrow(/remote\.url: invalid-url/)
  })

  it('allows writes with a visible surrounding-whitespace warning', () => {
    const config = { servers: { demo: { ...stdio('node'), args: [' server.mjs '] } } }
    expect(inspectMcpConfig(config).issues).toContainEqual({
      serverName: 'demo', field: 'args.0', code: 'surrounding-whitespace', severity: 'warning',
    })
    expect(() => assertMcpConfigValid(config)).not.toThrow()
  })
})
