import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import { sessionFormatV2ToV3, restoreReleasedV3Artifact } from '@deepseek-ai/dsh-session-format-v2-to-v3'
import { repairSessionArtifact } from '../../scripts/repair-edit-last-message-session.mjs'
import { createEditSource, editLastMessageSource } from '../../src/edit-last-message/shared.ts'
import { installEditAdmission } from '../../src/edit-last-message/host/rewind.ts'
import { editRootDefinition, editedUserDefinition } from '../../src/edit-last-message/client/conversation-nodes.ts'

describe('historical edits across DSH V3 migration', () => {
  it.each(['nested', 'custom'] as const)('repairs %s attribution without losing the root identity or replacement', async (shape) => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-edit-v3-'))
    try {
      const path = join(directory, 'session.jsonl')
      const header = { version: 2, id: 'edit-migration', createdAt: 1, isSeeded: false, delegationDepth: 0 }
      const marker = { version: 1, rootSeq: 2, rootMessageId: 'original / 中文' }
      const source = shape === 'custom' ? { kind: 'edit-last-message', ...marker }
        : { kind: 'plugin', plugin: 'edit-last-message', editLastMessage: marker }
      const input = [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'step/start', data: { turn: 1, step: 1 } },
        { type: 'user/message', data: { id: marker.rootMessageId, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'original' }] }, surfaceOp: 'append' },
        { type: 'user/message', data: { id: 'edited', role: 'user', source, content: [{ type: 'text', text: 'edited' }] }, surfaceOp: { op: 'replace', start: 2, end: 2 }, sourceEventSeqs: [2] },
      ].map((event, seq) => ({ ...event, seq, time: seq + 1 }))
      await writeFile(path, [header, ...input].map(row => JSON.stringify(row) + '\n').join(''))
      const repaired = await repairSessionArtifact(path, { write: true })
      expect(repaired.replacements).toBe(1)
      const rows = (await readFile(path, 'utf8')).trim().split('\n').map(row => JSON.parse(row))
      const targetHeader = sessionFormatV2ToV3.migrateHeader(header)
      const stage = sessionFormatV2ToV3.createStage({ sourceHeader: header, targetHeader, sourceInheritedEventCount: 0, sourceKind: 'decoded' })
      const collector = new SessionFormatEventCollector()
      for (const event of rows.slice(1)) stage.transformEvent(event, collector)
      const artifact = restoreReleasedV3Artifact({ header: targetHeader, inheritedEventCount: stage.finish(collector), events: collector.values }, new Set())
      const root = artifact.events.find(event => event.type === 'user/message')!
      const edit = artifact.events.at(-1)!
      expect(root.seq).toBe(3) // The migration inserted the protected system head.
      expect(edit.surfaceOp).toEqual({ op: 'replace', startSeq: root.seq, endSeq: root.seq })
      expect((edit.data as { source: unknown }).source).toEqual(createEditSource(marker.rootMessageId))
      expect(editLastMessageSource((edit.data as { source: unknown }).source)?.rootSeq).toBeUndefined()

      const rootState = editRootDefinition.start({} as never, { event: root } as never, { previous: () => undefined })
      const state = editedUserDefinition.start({} as never, { event: edit, location: { kind: 'unresolved' } } as never,
        { previous: () => ({ state: rootState }) } as never)
      expect(state.rootSeq).toBe(root.seq)
      expect(state.rootMessageId).toBe(marker.rootMessageId)

      // Recovered inbox attribution finds the original by ID, not its obsolete V2 seq.
      let intent: unknown
      const session = {
        surface: { nodes: [2, edit.seq] },
        snapshotEvents: () => artifact.events,
        eventAt: (seq: number) => artifact.events[seq],
        append: (_type: string, _data: unknown, options: unknown) => { intent = options; return { seq: edit.seq + 1 } },
      }
      const dispose = installEditAdmission(session as never)
      session.append('user/message', { id: 'recovered-edit', source: createEditSource(marker.rootMessageId) }, { surfaceOp: 'append' })
      expect(intent).toEqual({ surfaceOp: { op: 'replace', startSeq: edit.seq, endSeq: edit.seq }, sourceEventSeqs: [edit.seq] })
      dispose()
      expect((await repairSessionArtifact(path)).replacements).toBe(0)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
