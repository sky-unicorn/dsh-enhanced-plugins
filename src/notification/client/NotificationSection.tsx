/** Independent Settings section for native desktop alerts and the animated pet. */

import clsx from 'clsx'
import { useState, useSyncExternalStore, type ChangeEvent, type ReactNode } from 'react'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  NotificationCustomSound,
  NotificationSettings,
  NotificationSoundChoice,
  NotificationSoundEvent,
  PetPosition,
  PetSize,
} from '../shared.ts'
import type { NotificationLocaleKey } from './locales.ts'
import css from './NotificationSection.module.css'

const MAX_CUSTOM_SOUND_BYTES = 2 * 1024 * 1024

export interface NotificationSectionFace {
  hooks: { notificationSettings: SettingsScope<NotificationSettings> }
  soundLibrary: {
    getSnapshot: () => NotificationCustomSound[]
    subscribe: (listener: () => void) => () => void
  }
  set: <K extends keyof NotificationSettings>(field: K, value: NotificationSettings[K]) => void
  selectSound: (kind: NotificationSoundEvent, sound: NotificationSoundChoice) => Promise<void>
  reset: (field: keyof NotificationSettings) => void
  upload: (fileName: string, dataBase64: string) => Promise<void>
  preview: (kind: NotificationSoundEvent) => Promise<void>
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

function soundChoice(value: string, customSounds: NotificationCustomSound[]): NotificationSoundChoice | undefined {
  if (value === 'off' || value === 'subtle' || value === 'prominent') return value
  if (!value.startsWith('custom:')) return undefined
  const fileId = value.slice('custom:'.length)
  return customSounds.some(sound => sound.fileId === fileId) ? `custom:${fileId}` : undefined
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
  const customSounds = useSyncExternalStore(props.soundLibrary.subscribe, props.soundLibrary.getSnapshot)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | undefined>()
  const [previewing, setPreviewing] = useState<NotificationSoundEvent | undefined>()
  const [soundError, setSoundError] = useState<string | undefined>()
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

  const preview = async (kind: NotificationSoundEvent): Promise<void> => {
    setSoundError(undefined)
    setPreviewing(kind)
    try {
      await props.preview(kind)
    } catch {
      setSoundError(t('soundPreviewFailed'))
    } finally {
      setPreviewing(undefined)
    }
  }

  const selectSound = async (kind: NotificationSoundEvent, sound: NotificationSoundChoice): Promise<void> => {
    setSoundError(undefined)
    setPreviewing(kind)
    try {
      await props.selectSound(kind, sound)
    } catch {
      setSoundError(t('soundSelectionFailed'))
      setPreviewing(undefined)
      return
    }
    if (sound !== 'off') {
      try {
        await props.preview(kind)
      } catch {
        setSoundError(t('soundPreviewFailed'))
      }
    }
    setPreviewing(undefined)
  }

  const upload = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const input = event.currentTarget
    const files = Array.from(input.files ?? [])
    input.value = ''
    if (files.length === 0) return
    // WAV MIME values are inconsistent across browsers and operating systems.
    // The Host validates the RIFF/WAVE bytes before accepting the upload.
    if (files.some(file => !file.name.toLowerCase().endsWith('.wav'))) {
      setUploadError(t('customSoundType'))
      return
    }
    if (files.some(file => file.size === 0 || file.size > MAX_CUSTOM_SOUND_BYTES)) {
      setUploadError(t('customSoundSize'))
      return
    }
    setUploadError(undefined)
    setSoundError(undefined)
    setUploading(true)
    try {
      for (const file of files) {
        const dataBase64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()))
        await props.upload(file.name, dataBase64)
      }
    } catch {
      setUploadError(t('customSoundUploadFailed'))
    } finally {
      setUploading(false)
    }
  }

  const soundField = (kind: NotificationSoundEvent): ReactNode => {
    if (value === undefined) return null
    const soundFieldName = `${kind}Sound` as const
    const fileFieldName = `${kind}CustomSoundFile` as const
    const nameFieldName = `${kind}CustomSoundName` as const
    const customFile = value[fileFieldName]
    const customReady = customFile !== ''
    const selected = value[soundFieldName] === 'custom' ? `custom:${customFile}` : value[soundFieldName]
    const selectedKnown = value[soundFieldName] !== 'custom'
      || customSounds.some(sound => sound.fileId === customFile)
    const busy = uploading || previewing !== undefined
    const canPreview = selected !== 'off'
      && (value[soundFieldName] !== 'custom' || (customReady && selectedKnown))
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
            value={selected}
            disabled={disabled || busy}
            onChange={(event) => {
              const next = soundChoice(event.target.value, customSounds)
              if (next !== undefined) void selectSound(kind, next)
            }}
          >
            <option value="off">{t('soundOff')}</option>
            <option value="subtle">{t('soundSubtle')}</option>
            <option value="prominent">{t('soundProminent')}</option>
            {!selectedKnown ? (
              <option value={selected} disabled>
                {t('soundMissing')}{value[nameFieldName] === '' ? '' : `：${value[nameFieldName]}`}
              </option>
            ) : null}
            {customSounds.map(sound => (
              <option key={sound.fileId} value={`custom:${sound.fileId}`}>
                {t('soundCustomPrefix')}{sound.name}
              </option>
            ))}
          </select>
          <Button
            variant="outline"
            className={css.preview}
            aria-label={t(kind === 'completion' ? 'previewCompletionSound' : 'previewConfirmationSound')}
            disabled={disabled || busy || !canPreview}
            onClick={() => { void preview(kind) }}
          >
            {previewing === kind ? t('previewing') : t('previewSound')}
          </Button>
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
        {value === undefined ? null : (
          <FieldShell
            label={t('soundGain')}
            hint={t('soundGainHint')}
            overridden={overridden('soundGain')}
            overrideLabel={t('override')}
            resetLabel={t('reset')}
            disabled={disabled}
            onReset={() => { props.reset('soundGain') }}
          >
            <div className={css.volumeControl}>
              <input
                id="desktop-notification-gain"
                className={css.volumeRange}
                type="range"
                min={0}
                max={100}
                step={5}
                value={value.soundGain}
                aria-label={t('soundGain')}
                aria-valuetext={`+${value.soundGain}%`}
                disabled={disabled}
                onChange={(event) => { props.set('soundGain', Number(event.target.value)) }}
              />
              <label className={css.volumeValue}>
                <input
                  className={css.volumeNumber}
                  type="number"
                  min={0}
                  max={100}
                  step={5}
                  value={value.soundGain}
                  aria-label={t('soundGainPercent')}
                  disabled={disabled}
                  onChange={(event) => {
                    const next = Number(event.target.value)
                    if (Number.isInteger(next) && next >= 0 && next <= 100) props.set('soundGain', next)
                  }}
                />
                <span aria-hidden="true">%</span>
              </label>
            </div>
          </FieldShell>
        )}
        <section className={css.library}>
          <div className={css.libraryHeading}>
            <div>
              <div className={css.label}>{t('customSoundLibrary')}</div>
              <div className={css.hint}>{t('customSoundLibraryHint')}</div>
            </div>
            <label className={clsx(css.upload, (disabled || uploading) && css.uploadDisabled)}>
              <input
                className={css.fileInput}
                type="file"
                accept=".wav,audio/wav,audio/x-wav"
                multiple
                disabled={disabled || uploading}
                aria-label={t('chooseCustomSounds')}
                onChange={(event) => { void upload(event) }}
              />
              {uploading ? t('uploading') : t('uploadCustomSounds')}
            </label>
          </div>
          {customSounds.length === 0 ? <p className={css.libraryEmpty}>{t('customSoundLibraryEmpty')}</p> : (
            <ul className={css.libraryList} aria-label={t('customSoundLibrary')}>
              {customSounds.map(sound => <li key={sound.fileId} title={sound.name}>{sound.name}</li>)}
            </ul>
          )}
        </section>
        {uploadError === undefined ? null : <p className={css.notice} role="alert">{uploadError}</p>}
        {soundError === undefined ? null : <p className={css.notice} role="alert">{soundError}</p>}
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
