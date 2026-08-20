/** Independent Settings section for native desktop alerts and the animated pet. */

import clsx from 'clsx'
import { useState, type ChangeEvent, type ReactNode } from 'react'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  NotificationSettings, NotificationSound, NotificationSoundEvent, PetPosition, PetSize,
} from '../shared.ts'
import type { NotificationLocaleKey } from './locales.ts'
import css from './NotificationSection.module.css'

const MAX_CUSTOM_SOUND_BYTES = 2 * 1024 * 1024

export interface NotificationSectionFace {
  hooks: { notificationSettings: SettingsScope<NotificationSettings> }
  set: <K extends keyof NotificationSettings>(field: K, value: NotificationSettings[K]) => void
  reset: (field: keyof NotificationSettings) => void
  upload: (kind: NotificationSoundEvent, fileName: string, dataBase64: string) => Promise<void>
}

export type NotificationSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.desktopNotifications'>
  & InjectFace<NotificationSectionFace>

function rawUser(snapshot: SettingsScopeSnapshot<NotificationSettings>): Record<string, unknown> {
  return snapshot.user !== null && typeof snapshot.user === 'object' && !Array.isArray(snapshot.user)
    ? snapshot.user as Record<string, unknown>
    : {}
}

function soundValue(value: string): NotificationSound | undefined {
  return value === 'off' || value === 'subtle' || value === 'prominent' || value === 'custom'
    ? value
    : undefined
}

function positionValue(value: string): PetPosition | undefined {
  return value === 'top-left' || value === 'top-right' || value === 'bottom-left' || value === 'bottom-right'
    ? value
    : undefined
}

function sizeValue(value: string): PetSize | undefined {
  const size = Number(value)
  return size === 80 || size === 112 || size === 144 || size === 176 ? size : undefined
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

function FieldShell(props: {
  label: string
  hint: string
  overridden: boolean
  overrideLabel: string
  resetLabel: string
  disabled: boolean
  onReset: () => void
  children: ReactNode
}) {
  return (
    <section className={css.field}>
      <div className={css.fieldHeading}>
        <span className={css.label}>{props.label}</span>
        {props.overridden ? <span className={css.override}>{props.overrideLabel}</span> : null}
      </div>
      <div className={css.controlRow}>{props.children}</div>
      <div className={css.fieldFooter}>
        <span className={css.hint}>{props.hint}</span>
        {props.overridden ? (
          <button type="button" className={css.reset} disabled={props.disabled} onClick={props.onReset}>
            {props.resetLabel}
          </button>
        ) : null}
      </div>
    </section>
  )
}

/** Render a full page reached directly from the Settings navigation rail. */
export function NotificationSection(props: NotificationSectionProps) {
  const snapshot = props.useNotificationSettings(value => value)
  const [uploading, setUploading] = useState<NotificationSoundEvent | undefined>()
  const [uploadError, setUploadError] = useState<string | undefined>()
  const { t } = props

  if (snapshot.status === 'unavailable') {
    return (
      <div className={css.section}>
        <h2 className={css.title}>{t('title')}</h2>
        <p className={css.notice} role="alert">{t('unavailable')}</p>
      </div>
    )
  }

  const value = snapshot.value
  const disabled = snapshot.status !== 'ready' || !snapshot.writable || value === undefined
  const user = rawUser(snapshot)
  const overridden = (field: keyof NotificationSettings): boolean => Object.hasOwn(user, field)

  const upload = async (kind: NotificationSoundEvent, event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const input = event.currentTarget
    const file = input.files?.[0]
    input.value = ''
    if (file === undefined) return
    // WAV MIME values are inconsistent across browsers and operating systems.
    // The Host validates the RIFF/WAVE bytes before accepting the upload.
    if (!file.name.toLowerCase().endsWith('.wav')) {
      setUploadError(t('customSoundType'))
      return
    }
    if (file.size === 0 || file.size > MAX_CUSTOM_SOUND_BYTES) {
      setUploadError(t('customSoundSize'))
      return
    }
    setUploadError(undefined)
    setUploading(kind)
    try {
      const dataBase64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()))
      await props.upload(kind, file.name, dataBase64)
    } catch {
      setUploadError(t('customSoundUploadFailed'))
    } finally {
      setUploading(undefined)
    }
  }

  const soundField = (kind: NotificationSoundEvent): ReactNode => {
    if (value === undefined) return null
    const soundFieldName = `${kind}Sound` as const
    const fileFieldName = `${kind}CustomSoundFile` as const
    const nameFieldName = `${kind}CustomSoundName` as const
    const customReady = value[fileFieldName] !== ''
    const busy = uploading !== undefined
    return (
      <FieldShell
        label={t(kind === 'completion' ? 'completionSound' : 'confirmationSound')}
        hint={t(kind === 'completion' ? 'completionSoundHint' : 'confirmationSoundHint')}
        overridden={overridden(soundFieldName)}
        overrideLabel={t('override')}
        resetLabel={t('reset')}
        disabled={disabled || busy}
        onReset={() => { props.reset(soundFieldName) }}
      >
        <div className={css.soundControl}>
          <select
            className={css.select}
            aria-label={t(kind === 'completion' ? 'completionSound' : 'confirmationSound')}
            value={value[soundFieldName]}
            disabled={disabled || busy}
            onChange={(event) => {
              const next = soundValue(event.target.value)
              if (next !== undefined) props.set(soundFieldName, next)
            }}
          >
            <option value="off">{t('soundOff')}</option>
            <option value="subtle">{t('soundSubtle')}</option>
            <option value="prominent">{t('soundProminent')}</option>
            <option value="custom" disabled={!customReady && value[soundFieldName] !== 'custom'}>
              {t('soundCustom')}
            </option>
          </select>
          <label className={clsx(css.upload, (disabled || busy) && css.uploadDisabled)}>
            <input
              className={css.fileInput}
              type="file"
              accept=".wav,audio/wav,audio/x-wav"
              disabled={disabled || busy}
              aria-label={t(kind === 'completion' ? 'chooseCompletionSound' : 'chooseConfirmationSound')}
              onChange={(event) => { void upload(kind, event) }}
            />
            {uploading === kind ? t('uploading') : t(customReady ? 'replaceCustomSound' : 'chooseCustomSound')}
          </label>
          {customReady ? <span className={css.fileName} title={value[nameFieldName]}>{value[nameFieldName]}</span> : null}
        </div>
      </FieldShell>
    )
  }

  return (
    <div className={css.section}>
      <div className={css.heading}>
        <span className={css.headingIcon}><FishLogo size={28} /></span>
        <div>
          <h2 className={css.title}>{t('title')}</h2>
          <p className={css.description}>{t('description')}</p>
        </div>
      </div>
      <p className={css.intro}>{t('intro')}</p>

      <div className={css.statePreview} aria-label={t('states')}>
        <span className={clsx(css.state, css.stateIdle)}><FishLogo size={24} />{t('idle')}</span>
        <span className={clsx(css.state, css.stateWorking)}><FishLogo size={24} />{t('working')}</span>
        <span className={clsx(css.state, css.stateConfirmation)}><FishLogo size={24} />{t('confirmation')}</span>
        <span className={clsx(css.state, css.stateReady)}><FishLogo size={24} />{t('ready')}</span>
        <span className={clsx(css.state, css.stateBlocked)}><FishLogo size={24} />{t('blocked')}</span>
      </div>

      <div className={css.group}>
        <h3 className={css.groupTitle}>{t('sounds')}</h3>
        {soundField('completion')}
        {soundField('confirmation')}
        {uploadError === undefined ? null : <p className={css.notice} role="alert">{uploadError}</p>}
        <p className={css.note}>{t('customSoundNote')}</p>
      </div>

      {value === undefined ? <p className={css.notice}>{t('unavailable')}</p> : (
        <div className={css.group}>
          <h3 className={css.groupTitle}>{t('pet')}</h3>
          <FieldShell
            label={t('petEnabled')}
            hint={t('petEnabledHint')}
            overridden={overridden('petEnabled')}
            overrideLabel={t('override')}
            resetLabel={t('reset')}
            disabled={disabled}
            onReset={() => { props.reset('petEnabled') }}
          >
            <button
              type="button"
              role="switch"
              aria-checked={value.petEnabled}
              aria-label={t('petEnabled')}
              className={clsx(css.toggle, value.petEnabled && css.toggleOn)}
              disabled={disabled}
              onClick={() => { props.set('petEnabled', !value.petEnabled) }}
            >
              <span className={css.thumb} />
            </button>
          </FieldShell>

          <FieldShell
            label={t('petIdleTopmost')}
            hint={t('petIdleTopmostHint')}
            overridden={overridden('petIdleTopmost')}
            overrideLabel={t('override')}
            resetLabel={t('reset')}
            disabled={disabled}
            onReset={() => { props.reset('petIdleTopmost') }}
          >
            <button
              type="button"
              role="switch"
              aria-checked={value.petIdleTopmost}
              aria-label={t('petIdleTopmost')}
              className={clsx(css.toggle, value.petIdleTopmost && css.toggleOn)}
              disabled={disabled || !value.petEnabled}
              onClick={() => { props.set('petIdleTopmost', !value.petIdleTopmost) }}
            >
              <span className={css.thumb} />
            </button>
          </FieldShell>

          <FieldShell
            label={t('petSize')}
            hint={t('petSizeHint')}
            overridden={overridden('petSize')}
            overrideLabel={t('override')}
            resetLabel={t('reset')}
            disabled={disabled}
            onReset={() => { props.reset('petSize') }}
          >
            <select
              className={css.select}
              aria-label={t('petSize')}
              value={value.petSize}
              disabled={disabled || !value.petEnabled}
              onChange={(event) => {
                const next = sizeValue(event.target.value)
                if (next !== undefined) props.set('petSize', next)
              }}
            >
              <option value={80}>{t('sizeSmall')}</option>
              <option value={112}>{t('sizeMedium')}</option>
              <option value={144}>{t('sizeLarge')}</option>
              <option value={176}>{t('sizeExtraLarge')}</option>
            </select>
          </FieldShell>

          <FieldShell
            label={t('petPosition')}
            hint={t('petPositionHint')}
            overridden={overridden('petPosition')}
            overrideLabel={t('override')}
            resetLabel={t('reset')}
            disabled={disabled}
            onReset={() => { props.reset('petPosition') }}
          >
            <select
              className={css.select}
              aria-label={t('petPosition')}
              value={value.petPosition}
              disabled={disabled || !value.petEnabled}
              onChange={(event) => {
                const next = positionValue(event.target.value)
                if (next !== undefined) props.set('petPosition', next)
              }}
            >
              <option value="top-left">{t('topLeft')}</option>
              <option value="top-right">{t('topRight')}</option>
              <option value="bottom-left">{t('bottomLeft')}</option>
              <option value="bottom-right">{t('bottomRight')}</option>
            </select>
          </FieldShell>
          <p className={css.note}>{t('petMotionNote')}</p>
        </div>
      )}
      {!snapshot.writable && snapshot.status === 'ready'
        ? <p className={css.notice} role="status">{t('readOnly')}</p>
        : null}
    </div>
  )
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.desktopNotifications': NotificationLocaleKey
  }
}
