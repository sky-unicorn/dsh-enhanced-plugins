import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MarketCatalog, MarketErrorBody, MarketSyncStatus } from '../contracts.ts'
import type { MarketInstaller, InstallSnapshot } from './installer.ts'
import css from './PluginMarket.module.css'

/** The catalog contributes sources; installation remains owned by DSH through the market Host adapter. */
export interface MarketActions {
  readonly installer: MarketInstaller
  readonly openManager: () => void
}
export type PluginMarketProps = PropsRuntime<'settings.section'> & PropsLocale<'settings.pluginMarket'> & SettingsSectionOwnerProps & MarketActions

type ViewState = { readonly status: 'loading' } | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly catalog: MarketCatalog }

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/plugin-market/${path}`, init)
  const value: unknown = await response.json()
  if (!response.ok) throw new Error((value as MarketErrorBody).error?.message ?? `HTTP ${response.status}`)
  return value as T
}

function assertNever(value: never): never {
  throw new Error(`Unsupported DSH installation outcome: ${String(value)}`)
}

function outcome(state: InstallSnapshot, t: PluginMarketProps['t']): string {
  if (state.error) return t('outcomeUnknown')
  if (state.pending) return t(state.cancelling ? 'cancelling' : 'installing')
  const application = state.result?.application
  switch (application) {
    case undefined: return ''
    case 'applied': return t('applied')
    case 'restart-required': return t('restart')
    case 'overridden': return t('overridden')
    case 'failed': return t(state.result?.stage === 'enable' ? 'enableFailed' : 'installFailed')
    case 'cancelled': return t('cancelled')
    default: return assertNever(application)
  }
}

/** Browse the catalog and hand installation directly to DSH's current-profile manager. */
export function PluginMarket(props: PluginMarketProps): ReactNode {
  if (typeof location !== 'undefined' && location.protocol === 'dsh-app:') {
    return <section className={css.market}><p>{props.t('desktopManaged')}</p></section>
  }
  return <WebPluginMarket {...props} />
}

function WebPluginMarket({ t, installer, openManager, close }: PluginMarketProps): ReactNode {
  const [request, setRequest] = useState(0)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const install = useSyncExternalStore(installer.subscribe, installer.getSnapshot)

  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => { void api<MarketCatalog>(`catalog?page=${page}&query=${encodeURIComponent(query)}`, {
      signal: controller.signal,
    }).then(
      catalog => { if (!controller.signal.aborted) setState({ status: 'ready', catalog }) },
      error => { if (!controller.signal.aborted) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) }) },
    ) }, 250)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [page, query, request])

  // Poll only while this page is mounted; the catalog Host owns the sync lifetime.
  useEffect(() => {
    if (!syncing) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const status = await api<MarketSyncStatus>('sync', { signal: controller.signal })
        if (controller.signal.aborted) return
        if (status.state === 'failed') throw new Error(status.message)
        if (status.state === 'completed') {
          setNotice(t(status.result.unchanged ? 'syncUnchanged' : 'syncDone').replace('{count}', String(status.result.total)))
          setSyncing(false)
          setPage(1)
          setRequest(value => value + 1)
        } else timer = setTimeout(() => { void poll() }, 1000)
      } catch (error) {
        if (controller.signal.aborted) return
        setActionError(error instanceof Error ? error.message : String(error))
        setSyncing(false)
      }
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [syncing, t])

  const sync = async (): Promise<void> => {
    setActionError(null)
    setNotice(null)
    try {
      await api<MarketSyncStatus>('sync', { method: 'POST' })
      setSyncing(true)
    } catch (error) { setActionError(error instanceof Error ? error.message : String(error)) }
  }
  const manage = (): void => {
    try { openManager(); close() } catch (error) { setActionError(error instanceof Error ? error.message : String(error)) }
  }
  const result = install.result
  const pendingBuilds = result?.application === 'failed' ? result.pendingBuilds ?? [] : []
  const diagnostic = install.error ?? result?.error?.diagnostic ?? result?.packageResult?.output

  return <section className={css.market} aria-busy={state.status === 'loading'}>
    <header className={css.header}>
      <div className={css.headerIntro}><h3>{t('title')}</h3><p>{t('subtitle')}</p></div>
      <div className={css.headerActions}>
        <button className={css.configure} type="button" onClick={manage}>{t('manage')}</button>
        <button className={css.configure} type="button" disabled={syncing} onClick={() => { void sync() }}>{t(syncing ? 'syncing' : 'sync')}</button>
      </div>
    </header>
    {notice && <p className={css.notice} role="status">{notice}</p>}
    {actionError && <p className={css.actionError} role="alert">{actionError}</p>}
    {install.spec && <div className={css.installPlan}>
      <code>{install.spec}</code>
      <p role={result?.application === 'failed' || install.error ? 'alert' : 'status'}>{outcome(install, t)}</p>
      {diagnostic && <details><summary>{t('details')}</summary><pre className={css.diagnostic}>{diagnostic}</pre></details>}
      {result?.error && <p>{result.error.code}</p>}
      {result?.warnings?.map((warning, index) => <p key={index}>{warning}</p>)}
      {pendingBuilds.length > 0 && <>
        <p>{t('buildApproval')}</p><ul>{pendingBuilds.map(name => <li key={name}><code>{name}</code></li>)}</ul>
        <button className={css.configure} type="button" onClick={() => { void installer.approveAndRetry() }}>{t('approve')}</button>
      </>}
      {install.pending && <button className={css.configure} type="button" disabled={install.cancelling} onClick={() => { void installer.cancel() }}>{t('cancel')}</button>}
    </div>}
    {state.status === 'loading' && <p className={css.status}>{t('loading')}</p>}
    {state.status === 'error' && <div className={css.failure}><p role="alert">{t('error')} {state.message}</p>
      <button type="button" onClick={() => { setRequest(value => value + 1) }}>{t('retry')}</button></div>}
    <label className={css.search}><span className={css.visuallyHidden}>{t('search')}</span>
      <input type="search" value={query} placeholder={t('search')} onChange={event => { setQuery(event.currentTarget.value); setPage(1) }} /></label>
    {state.status === 'ready' && <>
      <dl className={css.meta}><div className={css.metaItem}><dt>{t('indexUpdated')}</dt>
        <dd><time dateTime={state.catalog.fetchedAt}>{new Date(state.catalog.fetchedAt).toLocaleString()}</time></dd></div></dl>
      {(state.catalog.indexStale ?? Date.now() - Date.parse(state.catalog.fetchedAt) > 86400000) && <p className={css.indexWarning}>{t('indexStale')}</p>}
      {state.catalog.total === 0 && <p className={css.status}>{t(query.trim() ? 'noMatch' : 'empty')}</p>}
      <ul className={css.grid}>{state.catalog.plugins.map(plugin => <li className={css.card} key={plugin.fullName}>
        <div className={css.identity}><img src={plugin.ownerAvatarUrl} alt="" width="36" height="36" loading="lazy" />
          <div><a href={plugin.url} target="_blank" rel="noreferrer" title={t('repository')}>{plugin.fullName}</a><code>{plugin.packageName}</code></div></div>
        <p className={css.description}>{plugin.description || t('noDescription')}</p>
        <div className={css.topics}>{plugin.topics.slice(0, 4).map(topic => <span key={topic}>{topic}</span>)}</div>
        <code className={css.installPlan}>{plugin.installSpec}</code>
        <footer><span aria-label={`${plugin.stars} ${t('stars')}`}>★ {plugin.stars}</span>
          <button type="button" disabled={install.pending} onClick={() => { void installer.install(plugin.installSpec) }}>{t('install')}</button></footer>
      </li>)}</ul>
      <div className={css.pagination}><span>{t('total').replace('{count}', String(state.catalog.total))}</span>
        <button type="button" disabled={page <= 1} onClick={() => { setPage(value => value - 1) }}>{t('previous')}</button>
        <span>{t('page').replace('{page}', String(page)).replace('{total}', String(state.catalog.totalPages))}</span>
        <button type="button" disabled={page >= state.catalog.totalPages} onClick={() => { setPage(value => value + 1) }}>{t('next')}</button></div>
    </>}
  </section>
}
