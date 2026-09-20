/** Settings card for curated pi-ai model request capabilities. */

import clsx from 'clsx'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the keyed card slot. Runtime collaboration stays on the slot and
// Settings services rather than importing another feature plugin's component.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import {
  isModelType, type ModelInputTypesError, type ModelInputTypesFace,
} from './controller.ts'
import type { ModelInputTypesLocaleKey } from './locales.ts'
import css from './ModelInputTypesCard.module.css'

/** Props injected by the bundle row configuration renderer. */
export type ModelInputTypesCardProps =
  PropsRuntime<'plugins.row.config'>
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

/** Render the row summary or its immediately saved model controls. */
export function ModelInputTypesCard(props: ModelInputTypesCardProps) {
  const state = props.useModelInputTypes(snapshot => snapshot)
  if (props.view === 'summary') return props.t('description')
  if (!state.available) return <p role="status">{props.t('unavailable')}</p>

  const { t } = props
  const disabled = !state.writable || state.loading || state.saving !== null
  const failure = errorCopy(t, state.error)
  const modelCount = state.providers.reduce((count, provider) => count + provider.models.length, 0)

  return (
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
                            <option value="image">{t('imagesOnly')}</option>
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
}
