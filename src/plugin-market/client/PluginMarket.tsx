import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  MarketCatalog,
  MarketCatalogFilter,
  MarketCredentialInfo,
  MarketErrorBody,
  MarketMutationResult,
  MarketPlugin,
  MarketSyncResult,
  MarketSyncStatus,
} from '../contracts.ts'
import type { LocaleKey } from './locales.ts'
import css from './PluginMarket.module.css'

export type PluginMarketProps = PropsRuntime<'settings.section'> & PropsLocale<'settings.pluginMarket'>

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly catalog: MarketCatalog }

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/plugin-market/${path}`, init)
  const value: unknown = await response.json()
  if (!response.ok) {
    const error = value as MarketErrorBody
    throw new Error(error.error?.message ?? `HTTP ${response.status}`)
  }
  return value as T
}

/** Searchable community catalog with explicit install and uninstall actions. */
export function PluginMarket({ t }: PluginMarketProps): ReactNode {
  const tabsId = useId()
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [request, setRequest] = useState(0)
  const [filter, setFilter] = useState<MarketCatalogFilter>('all')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [pending, setPending] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [configOpen, setConfigOpen] = useState(false)
  const [credential, setCredential] = useState<MarketCredentialInfo | null>(null)
  const [token, setToken] = useState('')
  const [configBusy, setConfigBusy] = useState<'save' | 'clear' | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncProgress, setSyncProgress] = useState<MarketSyncStatus>({ state: 'idle' })
  const configureButton = useRef<HTMLButtonElement>(null)
  const configWasOpen = useRef(false)

  useEffect(() => {
    let current = true
    const timer = setTimeout(() => { void api<MarketCatalog>(`catalog?page=${page}&query=${encodeURIComponent(query)}&filter=${filter}`).then(
      catalog => { if (current) setState({ status: 'ready', catalog }) },
      error => { if (current) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) }) },
    ) }, 250)
    return () => { current = false; clearTimeout(timer) }
  }, [filter, page, query, request])

  useEffect(() => {
    const restoreFocus = configWasOpen.current && !configOpen
      ? window.setTimeout(() => { configureButton.current?.focus() }, 0)
      : undefined
    configWasOpen.current = configOpen
    return () => {
      if (restoreFocus !== undefined) window.clearTimeout(restoreFocus)
    }
  }, [configOpen])

  const plugins = useMemo(() => state.status === 'ready' ? state.catalog.plugins : [], [state])
  const tabs: ReadonlyArray<{ readonly id: MarketCatalogFilter; readonly label: string }> = [
    { id: 'all', label: t('pluginsTab') },
    { id: 'installed', label: t('installedTab') },
  ]

  const retry = (): void => {
    setState({ status: 'loading' })
    setRequest(value => value + 1)
  }

  const selectFilter = (next: MarketCatalogFilter): void => {
    if (next === filter) return
    setFilter(next)
    setPage(1)
    setState({ status: 'loading' })
    setActionError(null)
  }

  const mutate = async (plugin: MarketPlugin): Promise<void> => {
    setPending(plugin.packageName)
    setActionError(null)
    setNotice(null)
    try {
      const result = await api<MarketMutationResult>(plugin.installed ? 'uninstall' : 'install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(plugin.installed
          ? { packageName: plugin.packageName }
          : { fullName: plugin.fullName }),
      })
      setNotice(plugin.installed
        ? t('uninstallDone')
        : t(result.source === 'npm' ? 'installNpmDone' : result.source === 'github' ? 'installGithubDone' : 'restart'))
      if (filter === 'installed') setPage(1)
      retry()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(null)
    }
  }

  const openConfig = async (): Promise<void> => {
    setConfigOpen(true)
    setActionError(null)
    try {
      setCredential(await api<MarketCredentialInfo>('config'))
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  const closeConfig = (): void => {
    setConfigOpen(false)
  }

  const saveToken = async (): Promise<void> => {
    setConfigBusy('save')
    setActionError(null)
    try {
      const info = await api<MarketCredentialInfo>('config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      setCredential(info)
      setToken('')
      setNotice(t('configSaved'))
      retry()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setConfigBusy(null)
    }
  }

  const clearToken = async (): Promise<void> => {
    setConfigBusy('clear')
    setActionError(null)
    try {
      const info = await api<MarketCredentialInfo>('config', { method: 'DELETE' })
      setCredential(info)
      setToken('')
      setNotice(t('configCleared'))
      retry()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setConfigBusy(null)
    }
  }

  const sync = async (): Promise<void> => {
    setSyncing(true)
    setActionError(null)
    setNotice(null)
    try {
      let status = await api<MarketSyncStatus>('sync', { method: 'POST' })
      setSyncProgress(status)
      while (status.state === 'running') {
        await new Promise(resolve => setTimeout(resolve, 1000))
        status = await api<MarketSyncStatus>('sync')
        setSyncProgress(status)
      }
      if (status.state === 'failed') throw new Error(status.message)
      if (status.state !== 'completed') throw new Error('同步任务没有返回完成状态。')
      const result: MarketSyncResult = status.result
      setNotice(t('syncDone').replace('{count}', String(result.total)))
      setPage(1)
      retry()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setSyncing(false)
    }
  }

  return (
    <section className={css.market} aria-busy={state.status === 'loading'}>
      <header className={css.header}>
        <div>
          <h3>{t('title')}</h3>
          <p>{t('subtitle')}</p>
        </div>
        <div className={css.headerActions}>
          {state.status === 'ready' ? (
            <div className={css.meta}>
            <span>{t('profile')}: <strong>{state.catalog.profile}</strong></span>
            {state.catalog.rateLimitRemaining === null ? null : (
              <span>{t('rateLimit')}: <strong>{state.catalog.rateLimitRemaining}</strong></span>
            )}
            </div>
          ) : null}
          <button ref={configureButton} className={css.configure} type="button" onClick={() => { void openConfig() }}>{t('configure')}</button>
          <button className={css.configure} type="button" disabled={syncing} onClick={() => { void sync() }}>
            {syncing ? t('syncing') : t('sync')}
          </button>
        </div>
      </header>

      <div className={css.tabs} role="tablist" aria-label={t('tabsLabel')}>
        {tabs.map((tab, index) => {
          const selected = tab.id === filter
          return (
            <button
              key={tab.id}
              ref={(element) => { tabRefs.current[index] = element }}
              id={`${tabsId}-tab-${tab.id}`}
              className={css.tab}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${tabsId}-panel-${tab.id}`}
              data-active={selected ? 'true' : undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => { selectFilter(tab.id) }}
              onKeyDown={(event) => {
                let nextIndex: number
                switch (event.key) {
                  case 'ArrowRight': nextIndex = (index + 1) % tabs.length; break
                  case 'ArrowLeft': nextIndex = (index - 1 + tabs.length) % tabs.length; break
                  case 'Home': nextIndex = 0; break
                  case 'End': nextIndex = tabs.length - 1; break
                  default: return
                }
                event.preventDefault()
                const next = tabs[nextIndex]
                const nextTab = tabRefs.current[nextIndex]
                if (next === undefined || nextTab === undefined || nextTab === null) return
                selectFilter(next.id)
                nextTab.focus()
              }}
            >
              {tab.label}
            </button>
          )
        })}
      </div>

      <div
        id={`${tabsId}-panel-${filter}`}
        className={css.catalogPanel}
        role="tabpanel"
        aria-labelledby={`${tabsId}-tab-${filter}`}
      >

      {notice === null ? null : <p className={css.notice} role="status">{notice}</p>}
      {syncProgress.state === 'running' ? (
        <p className={css.syncProgress} role="status">
          {t('syncProgress')
            .replace('{requests}', String(syncProgress.requests))
            .replace('{count}', String(syncProgress.discovered))
            .replace('{checked}', String(syncProgress.checked))
            .replace('{verified}', String(syncProgress.verified))}
        </p>
      ) : null}
      {actionError === null ? null : <p className={css.actionError} role="alert">{actionError}</p>}
      {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('error')} {state.message}</p>
          <button type="button" onClick={retry}>{t('retry')}</button>
        </div>
      ) : null}
      {state.status === 'ready' ? (
        <>
          <label className={css.search}>
            <span className={css.visuallyHidden}>{t('search')}</span>
            <input
              type="search"
              value={query}
              placeholder={t('search')}
              aria-label={t('search')}
              onChange={event => { setQuery(event.currentTarget.value); setPage(1) }}
            />
          </label>
          {state.catalog.fetchedAt === new Date(0).toISOString() ? <p className={css.status}>{t('neverSynced')}</p> : null}
          {state.catalog.total === 0 && query.trim().length === 0 ? (
            <p className={css.status}>{t(filter === 'installed' ? 'emptyInstalled' : 'empty')}</p>
          ) : null}
          {state.catalog.total === 0 && query.trim().length > 0 ? <p className={css.status}>{t('noMatch')}</p> : null}
          <ul className={css.grid}>
            {plugins.map(plugin => {
              const busy = pending === plugin.packageName
              return (
                <li className={css.card} key={plugin.fullName}>
                  <div className={css.identity}>
                    <img src={plugin.ownerAvatarUrl} alt="" width="36" height="36" loading="lazy" />
                    <div>
                      <a href={plugin.url} target="_blank" rel="noreferrer" title={t('repository')}>{plugin.fullName}</a>
                      <code>{plugin.packageName}</code>
                    </div>
                  </div>
                  <p className={css.description}>{plugin.description}</p>
                  <div className={css.topics}>
                    {plugin.topics.slice(0, 4).map(topic => <span key={topic}>{topic}</span>)}
                  </div>
                  <footer>
                    <span aria-label={`${plugin.stars} ${t('stars')}`}>★ {plugin.stars}</span>
                    <button
                      type="button"
                      data-installed={plugin.installed ? 'true' : undefined}
                      disabled={pending !== null}
                      onClick={() => { void mutate(plugin) }}
                    >
                      {busy ? t(plugin.installed ? 'uninstalling' : 'installing') : t(plugin.installed ? 'uninstall' : 'install')}
                    </button>
                  </footer>
                </li>
              )
            })}
          </ul>
          {state.catalog.total > 0 ? (
            <nav className={css.pagination} aria-label={t('page').replace('{page}', String(state.catalog.page)).replace('{total}', String(state.catalog.totalPages))}>
              <button type="button" disabled={state.catalog.page <= 1} onClick={() => { setPage(value => Math.max(1, value - 1)) }}>{t('previous')}</button>
              <span>{t('page').replace('{page}', String(state.catalog.page)).replace('{total}', String(state.catalog.totalPages))}</span>
              <span>{t('total').replace('{count}', String(state.catalog.total))}</span>
              <button type="button" disabled={state.catalog.page >= state.catalog.totalPages} onClick={() => { setPage(value => value + 1) }}>{t('next')}</button>
            </nav>
          ) : null}
        </>
      ) : null}
      </div>
      {configOpen ? (
        <div className={css.backdrop} role="presentation" onMouseDown={event => {
          if (event.target === event.currentTarget) closeConfig()
        }}>
          <div
            className={css.dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="plugin-market-config-title"
            onKeyDown={event => {
              if (event.key !== 'Escape') return
              event.preventDefault()
              event.stopPropagation()
              closeConfig()
            }}
          >
            <header>
              <h3 id="plugin-market-config-title">{t('configTitle')}</h3>
              <button type="button" aria-label={t('close')} onClick={closeConfig}>×</button>
            </header>
            <p>{t('configHelp')}</p>
            {actionError === null ? null : <p className={css.dialogError} role="alert">{actionError}</p>}
            {credential === null ? <p className={css.status}>{t('configLoading')}</p> : (
              <>
                <div className={css.credentialState}>
                  <span>{credential.configured ? t('configured') : t('notConfigured')}</span>
                  <code>{credential.ref}</code>
                  {credential.source === undefined ? null : <small>{t('source')}: {credential.source}</small>}
                </div>
                <label className={css.tokenField}>
                  <span>{t('tokenLabel')}</span>
                  <input
                    type="password"
                    value={token}
                    placeholder={t('tokenPlaceholder')}
                    autoComplete="off"
                    autoFocus
                    disabled={!credential.writable || configBusy !== null}
                    onChange={event => { setToken(event.currentTarget.value) }}
                  />
                </label>
                <div className={css.dialogActions}>
                  {credential.configured ? (
                    <button type="button" disabled={!credential.writable || configBusy !== null} onClick={() => { void clearToken() }}>
                      {configBusy === 'clear' ? t('clearing') : t('clear')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    data-primary="true"
                    disabled={!credential.writable || token.trim().length < 20 || configBusy !== null}
                    onClick={() => { void saveToken() }}
                  >
                    {configBusy === 'save' ? t('saving') : t('save')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </section>
  )
}
