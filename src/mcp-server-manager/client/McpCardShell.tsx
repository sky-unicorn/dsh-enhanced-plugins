/** MCP configuration form owned by its bundle row on the Plugins page. */
import { useEffect, useRef, type ReactNode } from 'react'
import type { CardShell } from './mcp-card-controller.ts'
import type { McpSettingsLocaleKey } from './locales.ts'
import css from './McpCardShell.module.css'

/** Form state and actions; leaving the page discards unsaved edits. */
export interface McpCardShellProps {
  t: (key: McpSettingsLocaleKey) => string
  state: CardShell
  onSave: () => void
  onDiscard: () => void
  children: ReactNode
}

/** Render controls and a single save action beneath the page-owned heading. */
export function McpCardShell(props: McpCardShellProps) {
  const { state } = props
  const discard = useRef(props.onDiscard)
  discard.current = props.onDiscard
  useEffect(() => () => { discard.current() }, [])
  if (!state.available) return <p className={css.readOnly} role="status">{props.t('mcpUnavailable')}</p>
  return (
    <div className={css.form}>
      {!state.writable ? <p className={css.readOnly} role="status">{props.t('readOnly')}</p> : null}
      {props.children}
      <div className={css.footer}>
        {state.failed ? <p className={css.failed} role="status">{props.t('saveFailed')}</p> : null}
        <button
          type="button"
          className={css.save}
          disabled={!state.writable || !state.dirty || state.invalid || state.saving}
          onClick={props.onSave}
        >
          {props.t(state.saving ? 'saving' : 'save')}
        </button>
      </div>
    </div>
  )
}
