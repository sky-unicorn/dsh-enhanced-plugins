import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelDirectory } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { NativeModelLock } from './NativeModelLock.tsx'
import { CollaborationIcon } from './CollaborationIcon.tsx'
import { TIERS, missingModelTiers, type RouterSnapshot } from '../shared.ts'
import type { NS } from './locales.ts'
import type { Injected } from './Views.tsx'
import css from './Router.module.css'

type ModeControlProps = PropsRuntime<'conversation.input.right'> & PropsLocale<typeof NS> & Injected & { directory: ModelDirectory; available: boolean }

/** Only a committed global enable mounts the composer entry and its owned resources. */
export function ModeControl(props: ModeControlProps) {
  const settings = useSyncExternalStore(fn => props.scope.subscribe(fn), () => props.scope.getSnapshot())
  return settings.value?.enabled ? <EnabledModeControl {...props}/> : null
}

/** Separate collaboration management from the single-model selector; managed mode locks the latter. */
function EnabledModeControl({ sessionId, directory, available, describe, command, scope, openDetails, t }: ModeControlProps) {
  const state = useSyncExternalStore(fn => directory.store.subscribe(fn), () => directory.store.getSnapshot())
  const settings = useSyncExternalStore(fn => scope.subscribe(fn), () => scope.getSnapshot())
  const [open, setOpen] = useState(false), [view, setView] = useState<RouterSnapshot>(), [busy, setBusy] = useState(false), [error, setError] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const lifetime = useRef<AbortController>(), writing = useRef(false)
  useEffect(() => {
    setView(undefined); setError(false); setBusy(false); setOpen(false); writing.current = false
    const abort = new AbortController(); lifetime.current = abort
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try { const result = await describe(sessionId, abort.signal); if (!abort.signal.aborted && !writing.current) { setView(old => !old || result.control.revision >= old.control.revision ? result : old); setError(false) } }
      catch { if (!abort.signal.aborted) setError(true) }
      if (!abort.signal.aborted) timer = setTimeout(() => void refresh(), 1000)
    }
    if (available) { void directory.load().catch(() => {}); void refresh() }
    return () => { abort.abort(); clearTimeout(timer) }
  }, [sessionId, available, describe, directory])
  const missing = missingModelTiers(settings.value?.models)
  const managed = view?.control.mode !== 'off'
  const select = async (id: string) => {
    setOpen(false)
    if (id === 'details') { openDetails?.(); return }
    const signal = lifetime.current?.signal
    if (!view || !signal || writing.current) return
    writing.current = true; setBusy(true); setError(false)
    try {
      const recovery = state.groups.flatMap(group => group.models.map(model => ({ id: JSON.stringify(['recover', group.id, model.id]), selection: { provider: group.id, model: model.id, ...(model.reasoning?.defaultEffort ? { reasoningEffort: model.reasoning.defaultEffort } : {}) } }))).find(item => item.id === id)
      if (id === 'toggle' || recovery) {
        const result = await command({ sessionId, action: 'mode', mode: managed ? 'off' : 'auto', expectedRevision: view.control.revision, operationId: crypto.randomUUID(), ...(recovery ? { restoreModel: recovery.selection } : {}) }, signal)
        if (!signal.aborted) setView(result)
      }
    } catch { if (!signal.aborted) setError(true) }
    finally { if (!signal.aborted) { writing.current = false; setBusy(false) } }
  }
  const collaborationItems: MenuEntry[] = [
    { id: 'toggle', label: t(managed ? 'disableSession' : 'enableSession'), disabled: !view || busy || (managed && view.requiresRestoreSelection) || (!managed && (!view.enabled || !!missing.length)) },
  ]
  if (missing.length) collaborationItems.push({ type: 'label', id: 'missing', text: `${t('missingModels')} ${missing.map(tier => t(tier)).join('、')}` })
  if (managed) {
    collaborationItems.push({ id: 'recover', label: t('recoverSelection'), submenu: state.groups.flatMap(group => group.models.map(model => ({ id: JSON.stringify(['recover', group.id, model.id]), label: `${model.name} · ${group.name}` }))) })
    const config = view?.run?.config ?? settings.value
    for (const tier of TIERS) collaborationItems.push({ type: 'label', id: tier, text: `${t(tier)} · ${config?.models[tier].model || t('unavailable')}` })
  }
  collaborationItems.push({ id: 'details', label: t('viewDetails') }, { type: 'label', id: 'settings', text: t('settingsPath') })
  return <div ref={anchor} className={css.modeControl}>
    <Menu open={open} portal side="top" align="end" items={collaborationItems} onClose={() => setOpen(false)} onSelect={id => void select(id)} anchor={<button className={css.composerButton} type="button" disabled={!available || busy || !view} aria-label={t('title')} aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(!open) }}><CollaborationIcon className={css.composerIcon}/><span className={css.composerLabel}>{t('title')}</span></button>}/>
    <NativeModelLock anchor={anchor} active={available && (managed || busy)} label={!view ? t('loading') : t('collaborationActive')} title={t('singleModelLocked')}/>

    {error && <span role="alert" className={css.muted}>{t('error')}</span>}
  </div>
}
