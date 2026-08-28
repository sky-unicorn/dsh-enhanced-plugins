import clsx from 'clsx'
import { useEffect, type ReactNode } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToggleState } from './store.ts'
import css from './ToggleSection.module.css'

export interface ToggleSectionInjected {
  hooks: { subagentProducts: SnapshotStore<ToggleState> }
  load: () => Promise<void>
  set: (product: 'claudeCode' | 'codex', enabled: boolean) => Promise<void>
}

export type ToggleSectionProps = PropsRuntime<'settings.section'>
  & PropsLocale<'settings.subagentProducts'>
  & InjectFace<ToggleSectionInjected>

export function ToggleSection({ useSubagentProducts, load, set, t }: ToggleSectionProps): ReactNode {
  const state = useSubagentProducts(value => value)
  useEffect(() => { void load() }, [load])
  if (state.status === 'unavailable') {
    return (
      <div className={css.section}>
        <h2 className={css.title}>{t('title')}</h2>
        <p className={css.error} role="alert">{t('unavailable')}</p>
      </div>
    )
  }

  const disabled = !state.writable || state.status === 'loading' || state.status === 'saving'
  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('title')}</h2>
      <p className={css.intro}>{t('intro')}</p>
      {([['claudeCode', 'Claude Code'], ['codex', 'Codex']] as const).map(([product, label]) => (
        <div className={css.row} key={product}>
          <div>
            <div className={css.name}>{label}</div>
            <div className={css.description}>{t(`${product}.description`)}</div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={state[product]}
            aria-label={`${label} ${t('enabled')}`}
            disabled={disabled}
            className={clsx(css.toggle, state[product] && css.toggleOn)}
            onClick={() => { void set(product, !state[product]) }}
          >
            <span className={css.thumb} />
          </button>
        </div>
      ))}
      {state.error === null ? null : (
        <p className={css.error} role="alert">
          {state.error.kind === 'conflict' ? t('conflict') : state.error.message}
        </p>
      )}
      <p className={css.note}>{t('note')}</p>
    </div>
  )
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.subagentProducts': string }
}
