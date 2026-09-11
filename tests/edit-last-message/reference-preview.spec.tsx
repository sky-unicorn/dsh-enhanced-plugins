import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditableUserMessage, EditedUserMessage } from '../../src/edit-last-message/client/EditableUserMessage.tsx'
import { en } from '../../src/edit-last-message/client/locales.ts'

afterEach(cleanup)

function fixture(edited: boolean) {
  const location = { kind: 'step', turn: { turn: 3 }, step: { step: 4 } }
  const data = {
    seq: 12, messageSeq: 12, time: 1_780_000_000_000,
    rootSeq: 2, rootMessageId: 'root', transactionId: 'edit',
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'Read @"folder/a.txt" with /guide and /unknown' }],
    skillNames: ['guide'],
  }
  const node = { kind: edited ? 'edited-user' : 'user', data, location }
  const context = (seq: number, name: string, turn = 3, step = 4) => ({
    kind: 'context', anchorSeq: seq,
    location: { kind: 'step', turn: { turn }, step: { step } },
    data: { source: { kind: 'skill-invocation', name } },
  })
  const snapshot = { order: ['message'], nodes: new Map([
    ['message', node], ['loaded', context(13, 'guide')],
    ['discarded', context(5, 'unknown', 1)], ['earlier', context(11, 'unknown')],
    ['other-step', context(14, 'unknown', 3, 5)],
  ]), legacy: { nodes: [{ kind: 'user', seq: 12 }] } }
  const openFile = vi.fn(), openSkill = vi.fn(), editAndResend = vi.fn()
  const props = {
    node, openFile, openSkill, editAndResend,
    renderMessageImages: () => null,
    useSession: (select: (state: unknown) => unknown) => select({ running: false, subagent: null }),
    useChat: (select: (state: unknown) => unknown) => select(snapshot),
    t: (key: keyof typeof en) => en[key],
  }
  return { props, snapshot, openFile, openSkill, editAndResend }
}

describe('rc.2 sent-reference navigation', () => {
  it.each([false, true])('previews files and evidenced skills without submitting (edited=%s)', (edited) => {
    const test = fixture(edited)
    const Component = edited ? EditedUserMessage : EditableUserMessage
    render(<Component {...test.props as never} />)
    fireEvent.click(screen.getByRole('button', { name: 'a.txt' }))
    fireEvent.click(screen.getByRole('button', { name: '/guide' }))
    expect(test.openFile).toHaveBeenCalledExactlyOnceWith('folder/a.txt')
    expect(test.openSkill).toHaveBeenCalledExactlyOnceWith('guide')
    expect(screen.queryByRole('button', { name: '/unknown' })).toBeNull()
    expect(test.editAndResend).not.toHaveBeenCalled()
  })

  it('drops skill decoration when the edited step has no loaded evidence', () => {
    const test = fixture(true)
    test.snapshot.nodes.delete('loaded')
    render(<EditedUserMessage {...test.props as never} />)
    expect(screen.queryByRole('button', { name: '/guide' })).toBeNull()
    expect(screen.getByRole('button', { name: 'a.txt' })).toBeTruthy()
  })
})
