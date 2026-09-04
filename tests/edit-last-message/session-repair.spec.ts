import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertReleasedPayloadSemantics } from '@dsh-test/session-format-v0-to-v1-validation'
import {
  repairSessionArtifact, scanZstdFrames,
} from '../../scripts/repair-edit-last-message-session.mjs'

const roots: string[] = []
const zstdOptions = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

function legacySource() {
  return {
    kind: 'plugin',
    plugin: 'edit-last-message',
    editLastMessage: { version: 1, rootSeq: 7, rootMessageId: 'original-message' },
  }
}

function message(source: unknown) {
  return {
    id: 'replacement-message',
    role: 'user',
    content: [{ type: 'text', text: 'replacement' }],
    source,
  }
}

async function decodedRows(path: string): Promise<Record<string, unknown>[]> {
  const bytes = await readFile(path)
  const rows: Record<string, unknown>[] = []
  for (const frame of scanZstdFrames(bytes)) {
    const plaintext = zstdDecompressSync(bytes.subarray(frame.start, frame.end)).toString('utf8')
    for (const value of plaintext.split('\n')) {
      if (value !== '') rows.push(JSON.parse(value) as Record<string, unknown>)
    }
  }
  return rows
}

describe('edit-last-message session repair', () => {
  it('backs up and converts both durable copies to a merge-extensible source kind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-edit-session-repair-'))
    roots.push(root)
    const path = join(root, 'session.jsonl.zstd')
    const header = { type: 'session', version: 0, id: 'session-1', createdAt: 1, cwd: 'C:\\work' }
    const inbox = {
      type: 'agent/inbox/spliced', seq: 2069, time: 2,
      data: { target: 'next-turn', start: 0, inserted: [message(legacySource())] },
    }
    const user = {
      type: 'user/message', seq: 2073, time: 3,
      data: message(legacySource()),
      surfaceOp: { op: 'replace', start: 7, end: 2066 },
      sourceEventSeqs: [7, 2066],
    }
    const original = Buffer.concat([
      zstdCompressSync(line(header), zstdOptions),
      zstdCompressSync(line(inbox), zstdOptions),
      zstdCompressSync(line(user), zstdOptions),
    ])
    await writeFile(path, original)

    const check = await repairSessionArtifact(path)
    expect(check).toMatchObject({ replacements: 2, affectedSeqs: [2069, 2073], backupPath: undefined })
    expect(await readFile(path)).toEqual(original)

    const repaired = await repairSessionArtifact(path, { write: true, now: new Date('2026-09-05T00:00:00Z') })
    expect(repaired).toMatchObject({ replacements: 2, affectedSeqs: [2069, 2073] })
    expect(repaired.backupPath).toBe(`${path}.edit-last-message-backup-2026-09-05T00-00-00-000Z`)
    expect(await readFile(repaired.backupPath!)).toEqual(original)

    const rows = await decodedRows(path)
    const expectedSource = {
      kind: 'edit-last-message', version: 1, rootSeq: 7, rootMessageId: 'original-message',
    }
    expect(rows[1]).toMatchObject({ data: { inserted: [{ source: expectedSource }] } })
    expect(rows[2]).toMatchObject({ data: { source: expectedSource } })
    expect(() => assertReleasedPayloadSemantics(rows[1] as never, 0)).not.toThrow()
    expect(() => assertReleasedPayloadSemantics(rows[2] as never, 0)).not.toThrow()

    const secondCheck = await repairSessionArtifact(path)
    expect(secondCheck).toMatchObject({ replacements: 0, affectedSeqs: [] })
  })
})
