import {
  useCallback, useEffect, useId, useMemo, useRef, useState,
} from 'react'
import { IconCodeOutline16, useAnchoredMaxHeight } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReferencedFileLocaleKey } from './locales.ts'
import { detectHashTrigger, replaceHashTrigger } from './references.ts'
import type { ReferencedFileCandidates } from './remote.ts'
import css from './ReferencedFileMenu.module.css'

/** Plugin-owned capability injected into every session-scoped menu entry. */
export interface ReferencedFileMenuInjected {
  search(sessionId: string, query: string, signal?: AbortSignal): Promise<ReferencedFileCandidates>
}

/** Full slot props: DSH's session kit, locale seat, and this plugin's search face. */
export type ReferencedFileMenuProps = PropsRuntime<'conversation.input.overlay'>
  & PropsLocale<'referenced-file.menu'>
  & ReferencedFileMenuInjected

type SearchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; result: ReferencedFileCandidates }
  | { status: 'error' }

const MAX_HEIGHT = 320
const SEARCH_DEBOUNCE_MS = 120

function pathParts(path: string): { directory?: string; name: string } {
  const separator = path.lastIndexOf('/')
  if (separator < 0) return { name: path }
  return { directory: path.slice(0, separator), name: path.slice(separator + 1) }
}

function formatSize(
  size: number | undefined,
  t: PropsLocale<'referenced-file.menu'>['t'],
): string | undefined {
  if (size === undefined) return undefined
  if (size < 1024) return t('size.bytes', { value: size })
  if (size < 1024 * 1024) return t('size.kilobytes', { value: Math.round(size / 1024) })
  return t('size.megabytes', { value: (size / (1024 * 1024)).toFixed(1) })
}

/** Session-scoped # candidate menu anchored above the stock composer. */
export function ReferencedFileMenu({
  sessionId, useInput, inputActions, search, t,
}: ReferencedFileMenuProps) {
  const draft = useInput(state => state.draft)
  const phase = useInput(state => state.phase)
  const anchorRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [caret, setCaret] = useState(draft.length)
  const [focused, setFocused] = useState(false)
  const [state, setState] = useState<SearchState>({ status: 'idle' })
  const [active, setActive] = useState(0)
  const instanceId = useId().replaceAll(':', '')
  const listId = `dsh-referenced-files-${instanceId}`

  const textarea = useCallback((): HTMLTextAreaElement | undefined =>
    anchorRef.current?.closest('[data-composer-card]')?.querySelector('textarea') ?? undefined, [])

  useEffect(() => {
    const sync = (event?: Event): void => {
      const input = textarea()
      if (input === undefined) return
      const ownsEvent = event === undefined || event.target === input || document.activeElement === input
      if (!ownsEvent) return
      setFocused(document.activeElement === input)
      setCaret(input.selectionStart ?? input.value.length)
    }
    sync()
    document.addEventListener('focusin', sync, true)
    document.addEventListener('focusout', sync, true)
    document.addEventListener('input', sync, true)
    document.addEventListener('click', sync, true)
    document.addEventListener('keyup', sync, true)
    document.addEventListener('selectionchange', sync)
    return () => {
      document.removeEventListener('focusin', sync, true)
      document.removeEventListener('focusout', sync, true)
      document.removeEventListener('input', sync, true)
      document.removeEventListener('click', sync, true)
      document.removeEventListener('keyup', sync, true)
      document.removeEventListener('selectionchange', sync)
    }
  }, [textarea])

  const hit = useMemo(
    () => phase === 'plain' && focused ? detectHashTrigger(draft, caret) : undefined,
    [caret, draft, focused, phase],
  )

  useEffect(() => {
    if (hit === undefined) {
      setState({ status: 'idle' })
      return
    }
    const controller = new AbortController()
    setState({ status: 'loading' })
    setActive(0)
    const timer = window.setTimeout(() => {
      void search(String(sessionId), hit.query, controller.signal).then(
        result => {
          if (!controller.signal.aborted) setState({ status: 'ready', result })
        },
        () => {
          if (!controller.signal.aborted) setState({ status: 'error' })
        },
      )
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [hit?.query, hit?.start, search, sessionId])

  const candidates = state.status === 'ready' ? state.result.candidates : []
  const open = hit !== undefined && state.status !== 'idle'
  const chosenIndex = candidates.length === 0 ? 0 : Math.min(active, candidates.length - 1)
  const optionId = (index: number): string => `${listId}-option-${index}`

  const choose = useCallback((index: number): void => {
    const candidate = candidates[index]
    if (candidate === undefined || hit === undefined) return
    const replacement = replaceHashTrigger(draft, hit, candidate.path)
    inputActions.setDraft(replacement.draft)
    setState({ status: 'idle' })
    window.requestAnimationFrame(() => {
      const input = textarea()
      if (input === undefined) return
      input.focus()
      input.setSelectionRange(replacement.caret, replacement.caret)
      setCaret(replacement.caret)
    })
  }, [candidates, draft, hit, inputActions, textarea])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (document.activeElement !== textarea() || event.isComposing) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setState({ status: 'idle' })
        return
      }
      if (state.status === 'loading' && (event.key === 'Enter' || event.key === 'Tab')) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (candidates.length === 0) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        const direction = event.key === 'ArrowDown' ? 1 : -1
        setActive(current => (current + direction + candidates.length) % candidates.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        event.stopPropagation()
        choose(chosenIndex)
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [candidates.length, choose, chosenIndex, open, state.status, textarea])

  useEffect(() => {
    const input = textarea()
    if (!open || input === undefined) return
    const previous = {
      controls: input.getAttribute('aria-controls'),
      expanded: input.getAttribute('aria-expanded'),
      active: input.getAttribute('aria-activedescendant'),
    }
    input.setAttribute('aria-controls', listId)
    input.setAttribute('aria-expanded', 'true')
    if (candidates.length > 0) input.setAttribute('aria-activedescendant', optionId(chosenIndex))
    else input.removeAttribute('aria-activedescendant')
    return () => {
      const restore = (name: string, value: string | null): void => {
        if (value === null) input.removeAttribute(name)
        else input.setAttribute(name, value)
      }
      restore('aria-controls', previous.controls)
      restore('aria-expanded', previous.expanded)
      restore('aria-activedescendant', previous.active)
    }
  }, [candidates.length, chosenIndex, listId, open, textarea])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return
      if (listRef.current?.contains(event.target)) return
      const card = anchorRef.current?.closest('[data-composer-card]')
      if (card?.contains(event.target)) return
      setState({ status: 'idle' })
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => { document.removeEventListener('pointerdown', onPointerDown, true) }
  }, [open])

  useEffect(() => {
    if (!open || candidates.length === 0) return
    document.getElementById(optionId(chosenIndex))?.scrollIntoView({ block: 'nearest' })
  }, [chosenIndex, candidates.length, open])

  const maxHeight = useAnchoredMaxHeight(listRef, MAX_HEIGHT, `${state.status}:${candidates.length}`)
  return (
    <div ref={anchorRef} className={css.root}>
      {open && (
        <div
          ref={listRef}
          id={listId}
          className={css.menu}
          style={{ maxHeight }}
          role="listbox"
          aria-label={t('suggestions.aria')}
        >
          <div className={css.viewport}>
            <div className={css.header} role="presentation">
              <span className={css.headerIcon} aria-hidden><IconCodeOutline16 /></span>
              <span className={css.headerTitle}>{t('title')}</span>
              <span className={css.headerHint}>{t('hint')}</span>
            </div>
            {state.status === 'loading' && <div className={css.status}>{t('loading')}</div>}
            {state.status === 'error' && <div className={css.status}>{t('error')}</div>}
            {state.status === 'ready' && candidates.length === 0 && (
              <div className={css.status}>{t('empty')}</div>
            )}
            {candidates.map((candidate, index) => {
              const selected = chosenIndex === index
              const size = formatSize(candidate.size, t)
              const parts = pathParts(candidate.path)
              return (
                <button
                  key={candidate.path}
                  id={optionId(index)}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  aria-label={t('file.aria', { path: candidate.path })}
                  className={`${css.item}${selected ? ` ${css.active}` : ''}`}
                  onMouseDown={event => {
                    event.preventDefault()
                    choose(index)
                  }}
                >
                  <span className={css.fileIcon} aria-hidden><IconCodeOutline16 /></span>
                  <span className={css.fileText}>
                    <span className={css.fileName}>{parts.name}</span>
                    {parts.directory !== undefined && <span className={css.directory}>{parts.directory}</span>}
                  </span>
                  {size !== undefined && <span className={css.size}>{size}</span>}
                </button>
              )
            })}
            {state.status === 'ready' && state.result.truncated && (
              <div className={css.limit} role="status">{t('truncated')}</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// Retain the key union in the generated declaration for locale consumers.
export type { ReferencedFileLocaleKey }
