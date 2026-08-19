import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EditCutEnd, EditableUserMessage, EditedUserMessage, editableText, type EditableUserMessageProps,
} from '../../src/edit-last-message/client/EditableUserMessage.tsx'
import { en } from '../../src/edit-last-message/client/locales.ts'

function user(seq: number, text: string) {
  return { kind: 'user', seq, time: 1_780_000_000_000, source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

function propsOf(options: {
  seq?: number
  text?: string
  running?: boolean
  latestSeq?: number
  editAndResend?: (request: { messageSeq: number; text: string }) => Promise<void>
} = {}): EditableUserMessageProps {
  const seq = options.seq ?? 7
  const data = user(seq, options.text ?? 'original prompt')
  const snapshot = {
    running: options.running ?? false,
    subagent: null,
    nodes: [user(options.latestSeq ?? seq, 'latest')],
    chat: {
      order: [] as string[],
      nodes: { values: () => [] as unknown[] },
    },
  }
  return {
    node: { key: `user:${seq}`, kind: 'user', data },
    loadImage: vi.fn(),
    useSession: (selector: (value: typeof snapshot) => unknown) => selector(snapshot),
    editAndResend: options.editAndResend ?? vi.fn().mockResolvedValue(undefined),
    t: (key, values) => {
      const template = en[key]
      return Object.entries(values ?? {}).reduce(
        (text, [name, value]) => text.replace(`{${name}}`, String(value)),
        template,
      )
    },
  } as EditableUserMessageProps
}

afterEach(() => { cleanup() })

describe('EditableUserMessage', () => {
  it('places Edit immediately beside Copy only for the stopped latest user bubble', () => {
    render(<EditableUserMessage {...propsOf()} />)
    const copy = screen.getByRole('button', { name: en['action.copy'] })
    const edit = screen.getByRole('button', { name: en['action.edit'] })
    expect(copy.nextElementSibling).toBe(edit)

    cleanup()
    render(<EditableUserMessage {...propsOf({ running: true })} />)
    expect(screen.queryByRole('button', { name: en['action.edit'] })).toBeNull()

    cleanup()
    render(<EditableUserMessage {...propsOf({ seq: 6, latestSeq: 7 })} />)
    expect(screen.queryByRole('button', { name: en['action.edit'] })).toBeNull()
  })

  it('edits inside the sent bubble and saves the replacement sequence and text', async () => {
    const editAndResend = vi.fn().mockResolvedValue(undefined)
    render(<EditableUserMessage {...propsOf({ editAndResend })} />)

    fireEvent.click(screen.getByRole('button', { name: en['action.edit'] }))
    const editor = screen.getByRole('textbox', { name: en['editor.label'] }) as HTMLTextAreaElement
    expect(editor.value).toBe('original prompt')
    expect(document.activeElement).toBe(editor)
    expect(editor.closest('[data-editing]')).not.toBeNull()
    expect(screen.getByText(en['editor.hint'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: en['action.copy'] })).toBeNull()
    fireEvent.change(editor, { target: { value: 'revised prompt' } })
    fireEvent.click(screen.getByRole('button', { name: en['action.save'] }))

    await waitFor(() => {
      expect(editAndResend).toHaveBeenCalledWith({ messageSeq: 7, text: 'revised prompt' })
    })
  })

  it('cancels inline editing without resending', () => {
    const editAndResend = vi.fn().mockResolvedValue(undefined)
    render(<EditableUserMessage {...propsOf({ editAndResend })} />)
    fireEvent.click(screen.getByRole('button', { name: en['action.edit'] }))
    fireEvent.change(screen.getByRole('textbox', { name: en['editor.label'] }), { target: { value: 'discard me' } })
    fireEvent.click(screen.getByRole('button', { name: en['action.cancel'] }))
    expect(screen.queryByRole('textbox', { name: en['editor.label'] })).toBeNull()
    expect(editAndResend).not.toHaveBeenCalled()
  })

  it('does not offer lossy editing for a message containing non-text blocks', () => {
    expect(editableText([
      { type: 'text', text: 'caption' },
      { type: 'image', attachment: { attachmentId: 'image-1' } },
    ] as never)).toBeUndefined()
  })

  it('hides the original raw bubble through the durable edit boundary', () => {
    const editedData = {
      transactionId: 'replacement-id',
      rootSeq: 7,
      rootMessageId: 'original-id',
      messageSeq: 21,
      time: 1_780_000_000_001,
      content: [{ type: 'text', text: 'revised prompt' }],
      source: { kind: 'plugin', plugin: 'edit-last-message' },
    }
    const snapshot = {
      running: false,
      subagent: null,
      nodes: [user(7, 'original prompt')],
      chat: {
        order: ['original', 'edited', 'context', 'end'],
        nodes: { values: () => [{ kind: 'edited-user', data: editedData }] },
      },
    }
    const shared = {
      loadImage: vi.fn(),
      useSession: (selector: (value: typeof snapshot) => unknown) => selector(snapshot),
      editAndResend: vi.fn().mockResolvedValue(undefined),
      t: propsOf().t,
    }

    const { container } = render(
      <div>
        <div data-chat-flow-key="13:input-messageoriginal-id" data-testid="original">old</div>
        <div data-chat-flow-key="25:edit-last-messagereplacement-id">
          <EditedUserMessage {...shared as never} node={{ kind: 'edited-user', data: editedData } as never} />
        </div>
        <div data-chat-flow-key="13:context" data-testid="discarded-context">old context</div>
        <div data-chat-flow-key="21:edit-last-message-endreplacement-id">
          <EditCutEnd node={{ kind: 'edit-cut-end', data: editedData } as never} />
        </div>
      </div>,
    )

    expect(screen.getByTestId('original')).toHaveProperty('hidden', true)
    expect(screen.getByTestId('discarded-context')).toHaveProperty('hidden', true)
    expect(container.querySelector('[data-edit-cut-start="replacement-id"]')?.closest('[data-chat-flow-key]'))
      .toHaveProperty('hidden', false)
  })
})
