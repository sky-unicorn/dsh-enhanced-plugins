/**
 * Unit tests for the card's pure form logic: staged-server reconciliation and
 * the path ops a save writes (one `set` per added server, one `unset` per
 * removed server, nothing for unchanged ones).
 */

import { describe, expect, it } from 'vitest'
import {
  collectArgs, collectPairs, planOps, recordsEqual, SERVER_NAME_PATTERN,
  isValidHttpUrl, McpCardController, type McpConfigSource, type McpServer,
} from '../../src/mcp-server-manager/client/mcp-card-controller.ts'
import type { McpConfigSnapshot, McpWireOp } from '../../src/mcp-server-manager/client/mcp-config-store.ts'

/** A config source over a mutable snapshot: mutate applies the ops like the real store's write-then-reread. */
function sourceOf(initial: McpConfigSnapshot): McpConfigSource {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    mutate: async (ops: readonly McpWireOp[], _expectedRevision?: number) => {
      const servers = { ...(snapshot.value?.servers ?? {}) }
      for (const op of ops) {
        if (op.path[0] !== 'servers' || op.path.length !== 2) return false
        const serverName = op.path[1]
        if (serverName === undefined) return false
        if (op.op === 'set') servers[serverName] = op.value as McpServer
        else delete servers[serverName]
      }
      snapshot = {
        ...snapshot,
        value: { servers },
        revision: (snapshot.revision ?? 0) + 1,
      }
      for (const listener of listeners) listener()
      return true
    },
    importServers: async () => ({
      imported: 1,
      duplicates: 1,
      renamed: 0,
      skipped: 0,
      found: { 'claude-code': true, codex: true },
      importedNames: ['imported'],
      issues: [],
    }),
  }
}

const serverA: McpServer = { transport: 'stdio', command: 'npx', args: ['-y'] }
const serverB: McpServer = { transport: 'streamable-http', url: 'https://x.test' }

describe('planOps', () => {
  it('writes one set per added server, one unset per removed, nothing for unchanged', () => {
    const ops = planOps({ a: serverA }, { a: serverA, b: serverB })
    expect(ops).toEqual([
      { op: 'set', path: ['servers', 'b'], value: serverB },
    ])
  })

  it('omits unchanged servers so masked secrets are never restated', () => {
    const ops = planOps({ a: serverA }, { a: serverA })
    expect(ops).toEqual([])
  })

  it('unsets removed servers', () => {
    const ops = planOps({ a: serverA, b: serverB }, { a: serverA })
    expect(ops).toEqual([
      { op: 'unset', path: ['servers', 'b'] },
    ])
  })

  it('handles replace and remove in one batch, set before unset', () => {
    const changed: McpServer = { transport: 'stdio', command: 'node', args: ['mcp.js'] }
    const ops = planOps({ a: serverA, b: serverB }, { a: changed })
    expect(ops).toEqual([
      { op: 'set', path: ['servers', 'a'], value: changed },
      { op: 'unset', path: ['servers', 'b'] },
    ])
  })
})

describe('collectArgs / collectPairs', () => {
  it('collects trimmed non-empty args, dropping blank rows', () => {
    expect(collectArgs(['', ' -y ', 'serve'])).toEqual(['-y', 'serve'])
  })

  it('collects key-value rows, dropping blank rows and overwriting repeats', () => {
    expect(collectPairs([
      { key: '', value: '' },
      { key: ' A ', value: '1' },
      { key: 'A', value: '2' },
    ])).toEqual({ A: '2' })
  })

  it('returns undefined when a row has a value but no key', () => {
    expect(collectPairs([{ key: '', value: 'orphan' }])).toBeUndefined()
  })
})

describe('recordsEqual', () => {
  it('compares structure regardless of key order', () => {
    expect(recordsEqual({ a: serverA, b: serverB }, { b: serverB, a: serverA })).toBe(true)
    expect(recordsEqual({ a: serverA }, { a: { ...serverA, command: 'other' } })).toBe(false)
  })
})

describe('isValidHttpUrl', () => {
  it('accepts HTTP(S) endpoints without embedded credentials', () => {
    expect(isValidHttpUrl('https://example.test/mcp')).toBe(true)
    expect(isValidHttpUrl('http://localhost:3000/mcp')).toBe(true)
  })

  it('refuses unsupported protocols, malformed URLs, and embedded credentials', () => {
    expect(isValidHttpUrl('ftp://example.test/mcp')).toBe(false)
    expect(isValidHttpUrl('not a url')).toBe(false)
    expect(isValidHttpUrl('https://user:secret@example.test/mcp')).toBe(false)
  })
})

describe('McpCardController', () => {
  it('stages add into a detached draft, then clears on save', async () => {
    const controller = new McpCardController(sourceOf({
      status: 'ready',
      writable: true,
      value: { servers: {} },
      revision: 1,
    }))
    const face = controller.inject()
    const snapshot = () => face.hooks.mcpCard.get()

    expect(snapshot().available).toBe(true)
    expect(snapshot().dirty).toBe(false)

    face.openForm()
    face.editForm('serverName', 'demo')
    face.editForm('command', 'npx')
    face.addServer()

    let state = snapshot()
    expect(state.dirty).toBe(true)
    expect(state.servers).toEqual([
      { serverName: 'demo', transport: 'stdio', target: 'npx', format: 'valid' },
    ])
    expect(state.format).toMatchObject({ valid: true, serverCount: 1, issues: [] })

    await face.save()
    state = snapshot()
    expect(state.dirty).toBe(false)
    expect(state.failed).toBe(false)
  })

  it('blocks the save while the staged form is invalid', () => {
    const controller = new McpCardController(sourceOf({
      status: 'ready',
      writable: true,
      value: { servers: {} },
      revision: 1,
    }))
    const face = controller.inject()
    face.openForm()
    face.editForm('serverName', 'demo')
    // No command → invalid.
    expect(snapshotOf(face).invalid).toBe(true)
    expect(snapshotOf(face).formInvalid).toBe(true)
  })

  it('refuses a duplicate serverName in the add form', () => {
    const controller = new McpCardController(sourceOf({
      status: 'ready',
      writable: true,
      value: { servers: { demo: serverA } },
      revision: 1,
    }))
    const face = controller.inject()
    face.openForm()
    face.editForm('serverName', 'demo')
    face.editForm('command', 'npx')
    expect(snapshotOf(face).formInvalid).toBe(true)
    face.addServer()
    expect(snapshotOf(face).dirty).toBe(false)
  })

  it('stages removal and shows the draft until save', async () => {
    const controller = new McpCardController(sourceOf({
      status: 'ready',
      writable: true,
      value: { servers: { demo: serverA, other: serverB } },
      revision: 2,
    }))
    const face = controller.inject()
    face.removeServer('demo')
    expect(snapshotOf(face).servers.map(row => row.serverName)).toEqual(['other'])
    await face.save()
    expect(snapshotOf(face).dirty).toBe(false)
  })

  it('discard drops the draft without writing', () => {
    const controller = new McpCardController(sourceOf({
      status: 'ready',
      writable: true,
      value: { servers: { demo: serverA } },
      revision: 1,
    }))
    const face = controller.inject()
    face.removeServer('demo')
    expect(snapshotOf(face).dirty).toBe(true)
    face.discard()
    expect(snapshotOf(face).dirty).toBe(false)
    expect(snapshotOf(face).servers.map(row => row.serverName)).toEqual(['demo'])
  })

  it('marks the card unavailable when the namespace is not served', () => {
    const controller = new McpCardController(sourceOf({
      status: 'unsupported',
      writable: false,
    }))
    expect(snapshotOf(controller.inject()).available).toBe(false)
  })

  it('runs the combined Host-side import and exposes only its safe summary', async () => {
    const controller = new McpCardController(sourceOf({
      status: 'ready',
      writable: true,
      value: { servers: {} },
      revision: 3,
    }))
    const face = controller.inject()
    face.importServers()
    expect(snapshotOf(face).importing).toBe(true)
    await waitFor(() => !snapshotOf(face).importing)
    expect(snapshotOf(face).importResult).toMatchObject({
      imported: 1,
      duplicates: 1,
      found: { 'claude-code': true, codex: true },
    })
    expect(snapshotOf(face).failed).toBe(false)
  })
})

function snapshotOf(face: ReturnType<McpCardController['inject']>) {
  return face.hooks.mcpCard.get()
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error('controller import did not settle')
}

// Wire-op shape guard used by tests that assert exact op lists.
void (0 as unknown as McpWireOp[])
void SERVER_NAME_PATTERN
