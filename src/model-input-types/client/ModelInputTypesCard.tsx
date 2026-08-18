/** Settings card for curated pi-ai model request capabilities. */

import { useState } from 'react'
import clsx from 'clsx'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: the keyed card slot. Runtime collaboration stays on the slot and
// Settings services rather than importing another feature plugin's component.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import {
  isModelType, type ModelInputTypesError, type ModelInputTypesFace,
} from './controller.ts'
import type { ModelInputTypesLocaleKey } from './locales.ts'
import css from './ModelInputTypesCard.module.css'

/** Props injected by the `settings.plugin.item` renderer. */
export type ModelInputTypesCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.modelInputTypes'>
  & InjectFace<ModelInputTypesFace>

/** Replace localized placeholders without embedding product copy in JSX. */
function template(copy: string, values: Readonly<Record<string, string>>): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, value),
    copy,
  )
}

/** Render a failure through localized conflict copy or the Host's safe message. */
function errorCopy(
  t: (key: ModelInputTypesLocaleKey) => string,
  error: ModelInputTypesError | null,
): string | undefined {
  if (error === null) return undefined
  return error.kind === 'conflict' ? t('conflict') : error.message
}

/** Render the card; an absent `llm-pi-ai` namespace leaves no UI trace. */
export function ModelInputTypesCard(props: ModelInputTypesCardProps) {
  const [open, setOpen] = useState(false)
  const state = props.useModelInputTypes(snapshot => snapshot)
  if (!state.available) return null

  const { t } = props
  const title = t('title')
  const disabled = !state.writable || state.loading || state.saving !== null
  const failure = errorCopy(t, state.error)
  const modelCount = state.providers.reduce((count, provider) => count + provider.models.length, 0)

  return (
    <li className={clsx(css.card, open && css.cardOpen)}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${title}`}
        onClick={() => { setOpen(current => !current) }}
      >
        <span className={css.headText}>
          <span className={css.name}>{title}</span>
          <span className={css.description}>{t('description')}</span>
        </span>
        <IconChevronDownOutline14 className={clsx(css.chevron, open && css.chevronOpen)} />
      </button>

      {open
        ? (
          <div className={css.body}>
            <p className={css.warning}>{t('warning')}</p>
            {!state.writable ? <p className={css.readOnly} role="status">{t('readOnly')}</p> : null}

            {modelCount === 0
              ? (
                <div className={css.empty}>
                  <span className={css.emptyTitle}>{t('empty')}</span>
                  <span className={css.emptyHint}>{t('emptyHint')}</span>
                </div>
              )
              : (
                <div className={css.providers}>
                  {state.providers.map(provider => (
                    <section className={css.provider} key={provider.provider}>
                      <header className={css.providerHeader}>
                        <span className={css.providerName}>{provider.displayName}</span>
                        {provider.displayName === provider.provider
                          ? null
                          : <span className={css.providerRoute}>{provider.provider}</span>}
                      </header>
                      <ul className={css.models}>
                        {provider.models.map((model, index) => {
                          const selectId = `model-input-type-${provider.provider}-${String(index)}`
                          return (
                            <li className={css.model} key={`${model.id}:${String(index)}`}>
                              <span className={css.modelIdentity}>
                                <span className={css.modelName}>{model.name}</span>
                                {model.name === model.id ? null : <span className={css.modelId}>{model.id}</span>}
                              </span>
                              <label className={css.typeField} htmlFor={selectId}>
                                <span className={css.typeLabel}>{t('modelType')}</span>
                                <select
                                  id={selectId}
                                  className={css.select}
                                  aria-label={template(t('modelTypeAria'), {
                                    provider: provider.provider,
                                    model: model.id,
                                  })}
                                  value={model.type}
                                  disabled={disabled}
                                  onChange={(event) => {
                                    const type = event.target.value
                                    if (isModelType(type)) {
                                      props.selectModelType(provider.provider, index, model.id, type)
                                    }
                                  }}
                                >
                                  <option value="default">{t('providerDefault')}</option>
                                  <option value="text">{t('textOnly')}</option>
                                  <option value="multimodal">{t('textAndImages')}</option>
                                </select>
                              </label>
                            </li>
                          )
                        })}
                      </ul>
                    </section>
                  ))}
                </div>
              )}

            <div
              className={clsx(css.status, failure !== undefined && css.statusError, state.saved && css.statusSaved)}
              role="status"
              aria-live="polite"
            >
              {failure ?? (state.saving !== null ? t('saving') : state.saved ? t('saved') : '')}
            </div>
          </div>
        )
        : null}
    </li>
  )
}
