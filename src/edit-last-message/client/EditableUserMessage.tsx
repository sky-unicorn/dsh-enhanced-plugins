import {
  useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode,
} from 'react'
import type { UserMessageNode } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ImageGallery } from '@deepseek-ai/dsh-client-ui-attachment'
import {
  Button, IconCheckOutline16, IconCopyOutline16, IconEditOutline16, IconLoadingOutline16,
  IconSendOutline16, JsonBlock, MessageText, Tooltip, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { EditLastMessageRequest } from './edit-session.ts'
import {
  isLatestRootEdit, latestEditableMessageSeq, type EditedUserChatData,
} from './conversation-nodes.ts'
import type { EditLastMessageLocaleKey } from './locales.ts'
import css from './EditableUserMessage.module.css'

type UserImage = Extract<UserMessageNode['content'][number], { type: 'image' }>

/** Actions injected by the slot registration for one session. */
export interface EditableUserMessageInjected {
  editAndResend(request: EditLastMessageRequest): Promise<void>
}

/** Full props for the shadowing user-message renderer. */
export type EditableUserMessageProps = PropsRuntime<'conversation.chat.node', 'user'>
  & PropsLocale<'edit-last-message'>
  & EditableUserMessageInjected

/** Props for the replacement projection rendered at the original bubble position. */
export type EditedUserMessageProps = PropsRuntime<'conversation.chat.node', 'edited-user'>
  & PropsLocale<'edit-last-message'>
  & EditableUserMessageInjected

/** Props for the invisible durable end marker of one discarded raw range. */
export type EditCutEndProps = PropsRuntime<'conversation.chat.node', 'edit-cut-end'>

/** Return complete editable text, or undefined when any block is non-text. */
export function editableText(content: UserMessageNode['content']): string | undefined {
  if (content.some(block => block.type !== 'text')) return undefined
  const text = content.map(block => block.type === 'text' ? block.text : '').join('')
  return text.trim().length === 0 ? undefined : text
}

function contentParts(content: UserMessageNode['content']): {
  text: string
  images: { attachment: UserImage['attachment'] }[]
  rest: unknown[]
} {
  const texts: string[] = []
  const images: { attachment: UserImage['attachment'] }[] = []
  const rest: unknown[] = []
  for (const block of content) {
    if (block.type === 'text') texts.push(block.text)
    else if (block.type === 'image') images.push({ attachment: block.attachment })
    else rest.push(block)
  }
  return { text: texts.join(''), images, rest }
}

function projectedText(text: string): ReactNode {
  const pattern = /(^|\s)([/@][\w-]+)(?=\s|$)/g
  const parts: ReactNode[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const tokenStart = match.index + (match[1]?.length ?? 0)
    const label = match[2] ?? ''
    if (tokenStart > cursor) parts.push(<MessageText key={cursor} text={text.slice(cursor, tokenStart)} />)
    parts.push(<span key={tokenStart} className={css.refChip}>{label}</span>)
    cursor = tokenStart + label.length
  }
  if (parts.length === 0) return <MessageText text={text} />
  if (cursor < text.length) parts.push(<MessageText key={cursor} text={text.slice(cursor)} />)
  return <>{parts}</>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const EDITOR_MAX_HEIGHT_PX = 192

interface EditableBubbleProps extends EditableUserMessageInjected {
  readonly data: Pick<UserMessageNode, 'seq' | 'time' | 'content' | 'source'>
  readonly loadImage: EditableUserMessageProps['loadImage']
  readonly useSession: EditableUserMessageProps['useSession']
  readonly t: EditableUserMessageProps['t']
}

/** Shared bubble body for an append-origin or replacement-projected user message. */
function EditableUserBubble({ data, loadImage, useSession, editAndResend, t }: EditableBubbleProps) {
  const { text, images, rest } = contentParts(data.content)
  const candidate = editableText(data.content)
  const running = useSession(snapshot => snapshot.running)
  const subagent = useSession(snapshot => snapshot.subagent !== null)
  const latestSeq = useSession(snapshot => latestEditableMessageSeq(snapshot))
  const canEdit = !running && !subagent && candidate !== undefined && latestSeq === data.seq
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(candidate ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => () => {
    if (copyTimer.current !== null) clearTimeout(copyTimer.current)
  }, [])
  useEffect(() => {
    if (!editing) return
    const textarea = textareaRef.current
    if (textarea === null) return
    textarea.focus()
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
  }, [editing])
  useLayoutEffect(() => {
    if (!editing) return
    const textarea = textareaRef.current
    if (textarea === null) return
    textarea.style.height = '0px'
    const nextHeight = Math.min(textarea.scrollHeight, EDITOR_MAX_HEIGHT_PX)
    textarea.style.height = `${Math.max(24, nextHeight)}px`
    textarea.style.overflowY = textarea.scrollHeight > EDITOR_MAX_HEIGHT_PX ? 'auto' : 'hidden'
  }, [draft, editing])
  useEffect(() => {
    if (!canEdit && editing) setEditing(false)
  }, [canEdit, editing])

  const onCopy = useCallback(() => {
    void writeClipboard(text).then((ok) => {
      if (!ok) return
      setCopied(true)
      if (copyTimer.current !== null) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => { setCopied(false) }, 1_000)
    })
  }, [text])
  const beginEdit = useCallback(() => {
    if (!canEdit || candidate === undefined) return
    setDraft(candidate)
    setError(null)
    setEditing(true)
  }, [canEdit, candidate])
  const cancelEdit = useCallback(() => {
    if (saving) return
    setEditing(false)
    setError(null)
  }, [saving])
  const save = useCallback(async () => {
    if (saving) return
    if (draft.trim().length === 0) {
      setError(t('error.empty'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      await editAndResend({ messageSeq: data.seq, text: draft })
    } catch (cause) {
      setError(t('error.failed', { message: errorMessage(cause) }))
      setSaving(false)
    }
  }, [data.seq, draft, editAndResend, saving, t])
  const onEditorKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      cancelEdit()
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      void save()
    }
  }, [cancelEdit, save])

  const imageLabels = {
    image: t('image.label'),
    open: t('image.open'),
    openNamed: (label: string) => t('image.openNamed', { label }),
    loading: t('image.loading'),
    loadFailed: t('image.loadFailed'),
    lightbox: {
      dialog: t('image.preview'),
      close: t('image.closePreview'),
    },
  }
  return (
    <div className={css.userRow} data-time-hover-root>
      <div className={css.userStack}>
        <ImageGallery images={images} load={loadImage} align="end" labels={imageLabels} />
        {(text !== '' || rest.length > 0) && (
          <div className={css.bubble} data-editing={editing || undefined}>
            {editing
              ? (
                  <div className={css.editorPanel} aria-busy={saving || undefined}>
                    <textarea
                      ref={textareaRef}
                      className={css.editor}
                      aria-label={t('editor.label')}
                      value={draft}
                      disabled={saving}
                      rows={1}
                      onChange={event => { setDraft(event.currentTarget.value) }}
                      onKeyDown={onEditorKeyDown}
                    />
                    {error !== null && <div className={css.editorError} role="alert">{error}</div>}
                    <div className={css.editorFooter}>
                      <span className={css.editorHint}>{t('editor.hint')}</span>
                      <div className={css.editorButtons}>
                        <Button
                          className={css.editorButton}
                          variant="ghost"
                          size="sm"
                          aria-label={t('action.cancel')}
                          disabled={saving}
                          onClick={cancelEdit}
                        >
                          {t('button.cancel')}
                        </Button>
                        <Button
                          className={css.editorButton}
                          variant="primary"
                          size="sm"
                          icon={saving
                            ? <IconLoadingOutline16 className={css.loadingIcon} />
                            : <IconSendOutline16 />}
                          aria-label={saving ? t('action.saving') : t('action.save')}
                          disabled={saving}
                          onClick={() => { void save() }}
                        >
                          {saving ? t('button.saving') : t('button.resend')}
                        </Button>
                      </div>
                    </div>
                  </div>
                )
              : (
                  <>
                    {projectedText(text)}
                    {rest.map((block, index) => (
                      <JsonBlock
                        key={index}
                        label={t('content.extraBlock')}
                        payload={block}
                        truncatedLabel={total => t('content.truncated', { total })}
                      />
                    ))}
                  </>
                )}
          </div>
        )}
      </div>
      {!editing && (
        <div className={css.actions}>
          <span className={css.time}>{new Date(data.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          <Tooltip label={copied ? t('action.copied') : t('action.copy')} side="bottom">
            <button type="button" className={css.action} aria-label={copied ? t('action.copied') : t('action.copy')} onClick={onCopy}>
              {copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
            </button>
          </Tooltip>
          {canEdit && (
            <Tooltip label={t('action.edit')} side="bottom">
              <button type="button" className={css.action} aria-label={t('action.edit')} onClick={beginEdit}>
                <IconEditOutline16 />
              </button>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  )
}

/** User bubble with inline edit-and-resend support on the stopped transcript tail. */
export function EditableUserMessage({
  node, loadImage, useSession, editAndResend, t,
}: EditableUserMessageProps) {
  return (
    <EditableUserBubble
      data={node.data}
      loadImage={loadImage}
      useSession={useSession}
      editAndResend={editAndResend}
      t={t}
    />
  )
}

function flowItemOf(node: HTMLElement | null): HTMLElement | null {
  return node?.closest<HTMLElement>('[data-chat-flow-key]') ?? null
}

function matchingFlowItem(flow: HTMLElement, attribute: 'chatFlowKey' | 'editCutEnd', value: string): HTMLElement | null {
  const selector = attribute === 'chatFlowKey' ? '[data-chat-flow-key]' : '[data-edit-cut-end]'
  for (const candidate of flow.querySelectorAll<HTMLElement>(selector)) {
    const actual = candidate.dataset[attribute]
    const matches = attribute === 'chatFlowKey'
      // DSH prefixes the opaque flow key and currently concatenates the
      // message id directly after `input-message`; match only that stable
      // identity suffix so prefix/order changes do not expose the old bubble.
      ? actual?.endsWith(`input-message${value}`) === true
      : actual === value
    if (!matches) continue
    return attribute === 'chatFlowKey' ? candidate : flowItemOf(candidate)
  }
  return null
}

/**
 * Hide only raw Chat rows shadowed by this durable replacement. The model
 * surface is authoritative; this DOM range is its presentation counterpart
 * because the built-in Chat builder intentionally retains append-origin rows.
 */
function useDiscardedRange(
  markerRef: { readonly current: HTMLDivElement | null },
  data: EditedUserChatData,
  active: boolean,
  flowRevision: string,
): void {
  useLayoutEffect(() => {
    if (!active) return
    const display = flowItemOf(markerRef.current)
    const flow = display?.parentElement
    if (display === null || flow === null || flow === undefined) return
    const end = matchingFlowItem(flow, 'editCutEnd', data.transactionId)
    if (end === null) return
    const original = matchingFlowItem(flow, 'chatFlowKey', data.rootMessageId)
    const hidden: HTMLElement[] = []
    let cursor: Element | null = original ?? display.nextElementSibling
    while (cursor instanceof HTMLElement && cursor !== end) {
      const next = cursor.nextElementSibling
      if (cursor !== display && !cursor.hidden) {
        cursor.hidden = true
        hidden.push(cursor)
      }
      cursor = next
    }
    return () => {
      for (const item of hidden) item.hidden = false
    }
  }, [active, data.rootMessageId, data.transactionId, flowRevision, markerRef])
}

/** Edited bubble projected at the first version's position in this same session. */
export function EditedUserMessage({
  node, loadImage, useSession, editAndResend, t,
}: EditedUserMessageProps) {
  const data = node.data
  const latest = useSession(snapshot => isLatestRootEdit(snapshot, data))
  const flowRevision = useSession(snapshot => {
    const order = snapshot.chat.order
    return `${order.length}:${order[0] ?? ''}:${order.at(-1) ?? ''}`
  })
  const markerRef = useRef<HTMLDivElement>(null)
  useDiscardedRange(markerRef, data, latest, flowRevision)
  if (!latest) return null
  return (
    <div ref={markerRef} data-edit-cut-start={data.transactionId}>
      <EditableUserBubble
        data={{
          seq: data.messageSeq,
          time: data.time,
          content: data.content,
          source: data.source,
        }}
        loadImage={loadImage}
        useSession={useSession}
        editAndResend={editAndResend}
        t={t}
      />
    </div>
  )
}

/** DOM landmark delimiting the raw rows hidden by one replacement. */
export function EditCutEnd({ node }: EditCutEndProps) {
  return <span data-edit-cut-end={node.data.transactionId} hidden aria-hidden />
}

// Retain the key union in the generated declaration for locale consumers.
export type { EditLastMessageLocaleKey }
