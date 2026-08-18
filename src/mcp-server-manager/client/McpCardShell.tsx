/**
 * The MCP card's shell: a header naming the card and disclosing its controls
 * in place, with the save that writes them. Ported from the settings card
 * chrome conventions so this package stands alone - cross-plugin
 * collaboration goes through slot and service seams, never a value import.
 *
 * The header is its own button rather than a shared disclosure row because a
 * card stacks its name over its description. Disclosure is card-local state:
 * which card a user has open is a reading gesture, not something the Host or
 * the section has any stake in. Staged edits outlive collapsing, so the
 * header marks a card holding unsaved edits.
 *
 * A card renders nothing while its namespace is unavailable: a deployment
 * that does not compose the owning plugin shows no trace of it, rather than
 * a disabled card the user cannot act on.
 */

import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CardShell } from './mcp-card-controller.ts'
import type { McpSettingsLocaleKey } from './locales.ts'
import css from './McpCardShell.module.css'

/** Card chrome props. */
export interface McpCardShellProps {
  /** Locale reader for this card's copy. */
  t: (key: McpSettingsLocaleKey) => string
  /** Locale key of the card's name. */
  titleKey: McpSettingsLocaleKey
  /** Locale key of the line describing what this card's settings govern. */
  descriptionKey: McpSettingsLocaleKey
  /** The card's form state: availability, writability, and what a save would do. */
  state: CardShell
  /** Write every staged edit. */
  onSave: () => void
  /** Drop every staged edit. */
  onDiscard: () => void
  /** The card's controls. */
  children: ReactNode
}

/**
 * Render the MCP card's shell.
 * @param props - the card's copy keys, its form state, and its controls.
 * @returns the card, or nothing when the namespace is unavailable.
 */
export function McpCardShell(props: McpCardShellProps) {
  const [open, setOpen] = useState(false)
  const { state } = props
  if (!state.available) return null
  const title = props.t(props.titleKey)
  const blocked = !state.dirty || state.invalid || state.saving
  return (
    <li className={clsx(css.card, open && css.cardOpen)}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-label={`${props.t(open ? 'collapse' : 'expand')}: ${title}`}
        onClick={() => { setOpen(!open) }}
      >
        <span className={css.headText}>
          <span className={css.name}>{title}</span>
          <span className={css.description}>{props.t(props.descriptionKey)}</span>
        </span>
        {state.dirty ? <span className={css.pending}>{props.t('unsaved')}</span> : null}
        <IconChevronDownOutline14 className={clsx(css.chevron, open && css.chevronOpen)} />
      </button>
      {open
        ? (
          <div className={css.body}>
            {!state.writable ? <p className={css.readOnly} role="status">{props.t('readOnly')}</p> : null}
            {props.children}
            <div className={css.footer}>
              {state.failed ? <p className={css.failed} role="status">{props.t('saveFailed')}</p> : null}
              <button
                type="button"
                className={css.discard}
                disabled={!state.dirty || state.saving}
                onClick={props.onDiscard}
              >
                {props.t('discard')}
              </button>
              <button
                type="button"
                className={css.save}
                disabled={blocked}
                onClick={props.onSave}
              >
                {props.t(state.saving ? 'saving' : 'save')}
              </button>
            </div>
          </div>
        )
        : null}
    </li>
  )
}
