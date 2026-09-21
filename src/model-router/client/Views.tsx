import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button, Menu, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { CollaborationIcon, ConfiguredModelPicker, Choice, FocusDialog, type LoadCatalog } from './Controls.tsx'
import type { PropsRuntime, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import { TIERS, missingModelTiers, type RouterConfig, type RouterSnapshot, type Mode } from '../shared.ts'
import type { RunQuery, RunPage } from '../shared.ts'
import type { NS } from './locales.ts'
import css from './Router.module.css'
import { useAutoSaveSettings } from './useAutoSaveSettings.ts'
import { RunDetails } from './RunDetails.tsx'

export interface Injected {
  openDetails?: () => void
  loadCatalog: LoadCatalog
  listRuns(query: RunQuery, signal: AbortSignal): Promise<RunPage>
  scope: SettingsScope<RouterConfig>
  describe(sessionId: string, signal: AbortSignal): Promise<RouterSnapshot>
  command(request: Record<string, unknown>, signal: AbortSignal): Promise<RouterSnapshot>
}
type Localized = PropsLocale<typeof NS>

export function Settings({ scope, describe, loadCatalog, t }: PropsRuntime<'settings.section'> & Localized & Injected) {
  const { snapshot, draft, revision, message, busy, update, reload } = useAutoSaveSettings(scope)
  const [phaseAvailable, setPhaseAvailable] = useState(false)
  useEffect(() => { const abort = new AbortController(); void describe('__capabilities__', abort.signal).then(v => { if (!abort.signal.aborted) setPhaseAvailable(!!v.phaseAvailable) }).catch(() => {}); return () => abort.abort() }, [describe])
  if (!draft || !snapshot.value) return <div className={css.section}>{t(snapshot.status === 'loading' ? 'loading' : 'unavailable')}</div>
  const missing = missingModelTiers(draft.models)
  return <section className={css.section}>
    <header className={css.heading}><CollaborationIcon/><div><h2>{t('title')}</h2><p>{t('intro')}</p></div></header>
    <div className={css.enableRow}><div><strong>{t('enabled')}</strong><p>{t('boundary')}</p>{!!missing.length && <p role="status">{t('missingModels')} {missing.map(tier => t(tier)).join('、')}</p>}</div><Switch checked={draft.enabled} disabled={busy || !snapshot.writable || (!draft.enabled && !!missing.length)} label={t('enabled')} onChange={checked => update(v => { v.enabled = checked })}/></div>
    {TIERS.map((tier, position) => <div className={css.roleCard} key={tier}><div className={css.roleHeader}><span className={css.roleNumber}>{position + 1}</span><strong>{t(tier)}</strong></div>
      <ConfiguredModelPicker t={t} label={`${t(tier)} · ${t('primaryModel')}`} value={draft.models[tier]} disabled={busy || !snapshot.writable} loadCatalog={loadCatalog} onChange={model => update(v => { v.models[tier] = model })}/>
    </div>)}
    <details className={css.card}><summary>{t('advanced')}</summary>
    <label className={css.field}>{t('maxConcurrentChildren')}<input type="number" min={1} max={4} className={css.control} value={draft.limits.maxConcurrentChildren} disabled={busy || !snapshot.writable} onChange={e => update(v => { v.limits.maxConcurrentChildren = Number(e.target.value) })} /></label>
    <label className={css.field}>{t('maxRetries')}<input className={css.control} type="number" min={0} max={3} value={draft.retry.maxRetries} onChange={e => update(v => { v.retry.maxRetries = Number(e.target.value) })} disabled={busy || !snapshot.writable} /></label>
    <details className={css.card}><summary>{t('rules')}</summary>
      <p className={css.muted}>{t('repairExplanation')}</p>
      <label className={css.row}><input type="checkbox" checked={draft.routing.autoUpgrade} disabled={busy || !snapshot.writable} onChange={e => update(v => { v.routing.autoUpgrade = e.target.checked })} />{t('autoUpgrade')}</label>
      <div className={css.row}>{(['repairFailuresBeforeUpgrade', 'maxEscalations'] as const).map(key => <label key={key} className={css.field}>{t(key)}<input className={css.control} type="number" min={key === 'maxEscalations' ? 0 : 1} max={key === 'maxEscalations' ? 2 : 3} value={draft.routing[key]} disabled={busy || !snapshot.writable} onChange={e => update(v => { v.routing[key] = Number(e.target.value) })} /></label>)}</div>
      <label className={css.row}><input type="checkbox" checked={draft.routing.phaseSwitch} disabled={busy || !snapshot.writable || !phaseAvailable} onChange={e => update(v => { v.routing.phaseSwitch = e.target.checked })} />{t('phaseSwitch')}</label>
      <p className={css.muted}>{t(phaseAvailable ? 'phaseExplanation' : 'phaseUnavailable')}</p>
    </details>
    </details>
    {!missing.length && TIERS.every(tier => JSON.stringify(draft.models[tier]) === JSON.stringify(draft.models.normal)) && <p role="status">{t('sameModels')}</p>}
    <p className={css.muted}>{t(snapshot.user && Object.keys(snapshot.user).length ? 'overridden' : 'inherited')}</p>
    {message && <p role="status">{t(message)}</p>}
    {(message === 'conflict' || revision !== snapshot.revision) && <Button variant="outline" disabled={busy} onClick={reload}>{t('reloadSettings')}</Button>}
  </section>
}

export function Conversation({ sessionId, scope, describe, command, listRuns, t, openDetails, embedded = false, onDetailsClose }: { sessionId: string; embedded?: boolean; onDetailsClose?: () => void } & Localized & Injected) {
  const [open, setOpen] = useState(embedded)
  const [menuOpen, setMenuOpen] = useState(false)
  const [view, setView] = useState<RouterSnapshot>()
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [fixed, setFixed] = useState('normal')
  const trigger = useRef<HTMLButtonElement>(null)
  const lifetime = useRef<AbortController>()
  const settings = useSyncExternalStore(scope.subscribe.bind(scope), scope.getSnapshot.bind(scope))
  useEffect(() => {
    if (!open) return
    const escape = (event: KeyboardEvent) => {
      if (!embedded && event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); setOpen(false); trigger.current?.focus() }
    }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [open, embedded])
  useEffect(() => {
    setView(undefined); setError(false); setBusy(false)
    if (!open) return
    const abort = new AbortController(); lifetime.current = abort
    let timer: ReturnType<typeof setTimeout>
    let initial = true
    const refresh = async () => {
      try { const result = await describe(sessionId, abort.signal); if (!abort.signal.aborted) { if (initial && result.control.fixedModel) { const model = result.control.fixedModel; const tier = TIERS.find(tier => scope.getSnapshot().value?.models[tier].provider === model.provider && scope.getSnapshot().value?.models[tier].model === model.model); if (tier) setFixed(tier) }; initial = false; setView(result); setError(false) } } catch { if (!abort.signal.aborted) setError(true) }
      if (!abort.signal.aborted) timer = setTimeout(() => void refresh(), 1500)
    }
    void refresh()
    return () => { abort.abort(); clearTimeout(timer) }
  }, [sessionId, open, describe, scope])
  const act = async (action: string, mode?: Mode) => {
    const signal = lifetime.current?.signal
    if (!view || !signal) return
    setBusy(true); setError(false)
    try {
      const model = settings.value?.models[fixed as keyof RouterConfig['models']]
      const value = await command({ sessionId, action, mode, ...(mode === 'fixed' ? { fixedModel: model } : {}), expectedRevision: view.control.revision, operationId: crypto.randomUUID() }, signal)
      if (!signal.aborted) setView(value)
    } catch { if (!signal.aborted) { setError(true); try { const fresh = await describe(sessionId, signal); if (!signal.aborted) setView(fresh) } catch { /* Polling retries after reconnect. */ } } } finally { if (!signal.aborted) setBusy(false) }
  }
  const missing = missingModelTiers(settings.value?.models)
  const close = () => { setOpen(false); trigger.current?.focus() }
  const details = <section className={css.section} role="region" aria-label={t('title')}>
      <header className={css.panelHeading}><CollaborationIcon/><h2>{t('title')}</h2>{onDetailsClose && <Button size="sm" onClick={onDetailsClose}>{t('close')}</Button>}</header>
      {error && <p role="alert" className={css.error}>{t('error')}</p>}
      {!view && <p role="status">{t('loading')}</p>}
      {view && <>
        {view.run ? <RunDetails run={view.run} t={t}/> : <p>{t('empty')}</p>}
      <details className={css.fold}><summary>{t('modeControls')}</summary><div className={css.foldBody}>
      {!view ? <p>{t('loading')}</p> : <>
        {!view.enabled && <p>{t('disabled')}</p>}
        {!!missing.length && <p role="status">{t('missingModels')} {missing.map(tier => t(tier)).join('、')}</p>}
        <div className={css.row}>{(['auto', 'fixed', 'off'] as const).map(mode => <button className={css.control} type="button" key={mode} aria-pressed={view.control.mode === mode} disabled={busy || error || (mode !== 'off' && (!view.enabled || !!missing.length))} onClick={() => void act('mode', mode)}>{t(mode)}</button>)}</div>
        <div className={css.field}><span>{t('fixed')}</span><Choice label={t('fixed')} value={fixed} disabled={busy} onChange={setFixed} options={TIERS.map(tier => ({ id: tier, label: `${t(tier)} · ${settings.value?.models[tier].model ?? ''}` }))}/></div>
        <p className={css.muted}>{t('boundary')}</p>
        <div className={css.row}>{(['pause', 'continue', 'cancel', 'new'] as const).map(action => <button className={css.control} key={action} type="button" disabled={busy || error || (action !== 'new' && !view.run)} onClick={() => void act(action)}>{t(action)}</button>)}</div>
        <p className={css.muted}>{t('newNote')}</p>
      </>}
      </div></details>
        <History key={sessionId} sessionId={sessionId} listRuns={listRuns} currentRunId={view.run?.id} t={t} />
      </>}
    </section>
  if (embedded) return details
  return <>
    <Menu open={menuOpen} portal side="top" align="end" anchor={<button className={css.composerButton} ref={trigger} type="button" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><CollaborationIcon/>{t('title')}</button>} items={[
      { type: 'label', id: 'title', text: t('title') },
      { id: 'details', label: t('viewDetails'), icon: <CollaborationIcon/> },
      { type: 'label', id: 'settings', text: t('settingsPath') },
    ]} onSelect={() => { setMenuOpen(false); if (openDetails) openDetails(); else setOpen(true) }} onClose={() => setMenuOpen(false)}/>
    <FocusDialog open={open} close={close} title={t('title')} closeLabel={t('close')}>{details}</FocusDialog>
  </>
}

function History({ sessionId, listRuns, currentRunId, t }: Pick<Injected, 'listRuns'> & { sessionId: string; currentRunId?: string } & Localized) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState<RunQuery>({ sessionId })
  const [page, setPage] = useState<RunPage>()
  const [error, setError] = useState(false)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    if (!open) return
    const abort = new AbortController(); setPage(undefined); setError(false)
    void listRuns({ ...query, sessionId }, abort.signal).then(value => { if (!abort.signal.aborted) setPage(value) }).catch(() => { if (!abort.signal.aborted) setError(true) })
    return () => abort.abort()
  }, [sessionId, listRuns, query, refresh, open])
  return <details className={css.fold} onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open) }}><summary>{t('history')}</summary><div className={css.foldBody}>
    <details className={css.inlineDetails}><summary>{t('filterHistory')}</summary><div className={css.foldBody}><div className={css.row}>
      <div className={css.field}><span>{t('status')}</span><Choice label={t('status')} value={query.status ?? ''} onChange={value => setQuery({ ...query, cursor: undefined, status: value as RunQuery['status'] || undefined })} options={[{ id: '', label: t('all') }, ...(['running', 'pausing', 'paused', 'cancelled', 'interrupted', 'completed'] as const).map(id => ({ id, label: t(id === 'completed' ? 'executionEnded' : id) }))]}/></div>
      <div className={css.field}><span>{t('role')}</span><Choice label={t('role')} value={query.role ?? ''} onChange={value => setQuery({ ...query, cursor: undefined, role: value as RunQuery['role'] || undefined })} options={[{ id: '', label: t('all') }, ...(['main', 'search', 'execute', 'expert'] as const).map(id => ({ id, label: t(id) }))]}/></div>
    </div>
    {(['model', 'runId'] as const).map(key => <label className={css.field} key={key}>{t(key)}<input className={css.control} value={query[key] ?? ''} onChange={e => setQuery({ ...query, cursor: undefined, [key]: e.target.value || undefined })} /></label>)}
    </div></details>
    <button className={css.control} type="button" onClick={() => { setQuery({ ...query, cursor: undefined }); setRefresh(n => n + 1) }}>{t('refresh')}</button>
    {error ? <p role="alert">{t('unavailable')}</p> : !page ? <p role="status">{t('loading')}</p> : <>
      {!page.runs.some(run => run.id !== currentRunId) && <p>{t('noRuns')}</p>}
      {page.runs.filter(run => run.id !== currentRunId).map(run => <details key={run.id} className={css.card}><summary>{new Date(run.createdAt).toLocaleString()} · {t(run.status === 'completed' ? 'executionEnded' : run.status)} · {run.id}</summary><RunDetails run={run} t={t} historical /></details>)}
      {page.nextCursor && <button className={css.control} type="button" onClick={() => setQuery({ ...query, cursor: page.nextCursor })}>{t('nextPage')}</button>}
    </>}
  </div></details>
}
