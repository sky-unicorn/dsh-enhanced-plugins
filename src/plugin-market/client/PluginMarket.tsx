import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  MarketCatalog,
  MarketCatalogFilter,
  MarketCredentialInfo,
  MarketErrorBody,
  MarketInstallPlan,
  MarketInstallPlanJob,
  MarketMutationJob,
  MarketMutationResult,
  MarketPlugin,
  MarketSyncResult,
  MarketSyncStatus,
} from '../contracts.ts'
import type { LocaleKey } from './locales.ts'
import css from './PluginMarket.module.css'

export type PluginMarketProps = PropsRuntime<'settings.section'> & PropsLocale<'settings.pluginMarket'>

function assertNever(value: never): never {
  throw new Error(`Unsupported plugin market value: ${JSON.stringify(value)}`)
}

function installPlanMessage(plan: MarketInstallPlan, t: PluginMarketProps['t']): string {
  switch (plan.kind) {
    case 'npm': return t('npmPlan').replace('{version}', plan.version)
    case 'github': return t('githubPlan').replace('{commit}', plan.commit.slice(0, 8))
    case 'manual':
      switch (plan.reason) {
        case 'requires-build-approval': return t('manualBuildPlan')
        case 'missing-integrity': return t('manualIntegrityPlan')
        case 'no-automatic-source': return t('manualPlan')
        default: return assertNever(plan.reason)
      }
    default: return assertNever(plan)
  }
}

function installPlanAction(plan: Exclude<MarketInstallPlan, { readonly kind: 'manual' }>, t: PluginMarketProps['t']): string {
  switch (plan.kind) {
    case 'npm': return t('oneClickInstall')
    case 'github': return t('installSource')
    default: return assertNever(plan)
  }
}

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly catalog: MarketCatalog }

const INDEX_STALE_AFTER_MS = 24 * 60 * 60 * 1000

function indexIsStale(catalog: MarketCatalog): boolean {
  if (catalog.indexStale !== undefined) return catalog.indexStale
  const generatedAt = Date.parse(catalog.fetchedAt)
  return !Number.isFinite(generatedAt) || Date.now() - generatedAt > INDEX_STALE_AFTER_MS
}

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
  const [pending, setPending] = useState<{ readonly fullName: string; readonly jobId: string } | null>(null)
  const [planning, setPlanning] = useState<string | null>(null)
  const [plans, setPlans] = useState<Readonly<Record<string, MarketInstallPlan>>>({})
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

  const inspectPlan = async (plugin: MarketPlugin): Promise<void> => {
    setPlanning(plugin.fullName)
    setActionError(null)
    setNotice(null)
    try {
      let job = await api<MarketInstallPlanJob>('install-plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fullName: plugin.fullName }),
      })
      while (job.state === 'running') {
        await new Promise(resolve => setTimeout(resolve, 750))
        job = await api<MarketInstallPlanJob>(`install-plans/${job.id}`)
      }
      switch (job.state) {
        case 'completed': setPlans(current => ({ ...current, [plugin.fullName]: job.plan })); break
        case 'failed': throw new Error(job.message)
        default: return assertNever(job)
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setPlanning(null)
    }
  }

  const waitForJob = async (initial: MarketMutationJob): Promise<MarketMutationJob> => {
    let job = initial
    while (job.state === 'running') {
      await new Promise(resolve => setTimeout(resolve, 750))
      job = await api<MarketMutationJob>(`jobs/${job.id}`)
    }
    return job
  }

  const mutate = async (plugin: MarketPlugin): Promise<void> => {
    const plan = plans[plugin.fullName]
    if (plugin.installed && !plugin.removable) return
    if (!plugin.installed && plan === undefined) {
      await inspectPlan(plugin)
      return
    }
    if (!plugin.installed && plan?.kind === 'manual') return
    setActionError(null)
    setNotice(null)
    try {
      const started = await api<MarketMutationJob>(plugin.installed ? 'uninstall' : 'install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(plugin.installed
          ? { packageName: plugin.packageName }
          : {
            fullName: plugin.fullName,
            planKind: plan?.kind,
            expectedRef: plan?.kind === 'npm' ? plan.version : plan?.kind === 'github' ? plan.commit : undefined,
            confirmSource: plan?.kind === 'github',
          }),
      })
      setPending({ fullName: plugin.fullName, jobId: started.id })
      const job = await waitForJob(started)
      let result: MarketMutationResult
      switch (job.state) {
        case 'completed': result = job.result; break
        case 'cancelled': setNotice(t('operationCancelled')); return
        case 'failed': throw new Error(job.message)
        case 'running': throw new Error(t('jobIncomplete'))
        default: return assertNever(job)
      }
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

  const cancelMutation = async (): Promise<void> => {
    if (pending === null) return
    setActionError(null)
    try {
      await api<MarketMutationJob>(`jobs/${pending.jobId}`, { method: 'DELETE' })
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
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
      setNotice(t(result.unchanged === true ? 'syncUnchanged' : 'syncDone').replace('{count}', String(result.total)))
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
        <div className={css.headerIntro}>
          <h3>{t('title')}</h3>
          <p>{t('subtitle')}</p>
        </div>
        <div className={css.headerActions}>
          <button ref={configureButton} className={css.configure} type="button" onClick={() => { void openConfig() }}>{t('configure')}</button>
          <button className={css.configure} data-primary="true" type="button" disabled={syncing} onClick={() => { void sync() }}>
            {syncing ? t('syncing') : t('sync')}
          </button>
        </div>
      </header>

      {state.status === 'ready' ? (
        <dl className={css.meta}>
          <div className={css.metaItem}>
            <dt>{t('profile')}</dt>
            <dd>{state.catalog.profile}</dd>
          </div>
          <div className={css.metaItem}>
            <dt>{t('indexUpdated')}</dt>
            <dd><time dateTime={state.catalog.fetchedAt}>{new Date(state.catalog.fetchedAt).toLocaleString()}</time></dd>
          </div>
          {state.catalog.rateLimitRemaining === null ? null : (
            <div className={css.metaItem}>
              <dt>{t('rateLimit')}</dt>
              <dd>{state.catalog.rateLimitRemaining}</dd>
            </div>
          )}
        </dl>
      ) : null}

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
          {indexIsStale(state.catalog) ? <p className={css.indexWarning} role="status">{t('indexStale')}</p> : null}
          {state.catalog.total === 0 && query.trim().length === 0 ? (
            <p className={css.status}>{t(filter === 'installed' ? 'emptyInstalled' : 'empty')}</p>
          ) : null}
          {state.catalog.total === 0 && query.trim().length > 0 ? <p className={css.status}>{t('noMatch')}</p> : null}
          <ul className={css.grid}>
            {plugins.map(plugin => {
              const busy = pending?.fullName === plugin.fullName
              const plan = plans[plugin.fullName]
              const checking = planning === plugin.fullName
              const actionLabel = plugin.installed
                ? t(plugin.removable ? 'uninstall' : 'installed')
                : plan === undefined
                  ? t('checkInstall')
                  : plan.kind === 'manual'
                    ? t('viewInstructions')
                    : installPlanAction(plan, t)
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
                  {plugin.installed && !plugin.removable ? (
                    <p className={css.installPlan} data-kind="managed">
                      {t('managedExternally')}
                    </p>
                  ) : plan === undefined ? null : (
                    <p className={css.installPlan} data-kind={plan.kind}>
                      {installPlanMessage(plan, t)}
                    </p>
                  )}
                  <footer>
                    <span aria-label={`${plugin.stars} ${t('stars')}`}>★ {plugin.stars}</span>
                    {!plugin.installed && plan?.kind === 'manual' ? (
                      <a className={css.manualAction} href={plan.documentationUrl} target="_blank" rel="noreferrer">
                        {t('viewInstructions')}
                      </a>
                    ) : (
                      <button
                        type="button"
                        data-installed={plugin.installed ? 'true' : undefined}
                        data-readonly={plugin.installed && !plugin.removable ? 'true' : undefined}
                        data-source={plan?.kind}
                        disabled={(plugin.installed && !plugin.removable)
                          || (pending !== null && !busy)
                          || (planning !== null && !checking)
                          || checking}
                        onClick={() => { void (busy ? cancelMutation() : mutate(plugin)) }}
                      >
                        {busy
                          ? t('cancelOperation')
                          : checking
                            ? t('checkingInstall')
                            : actionLabel}
                      </button>
                    )}
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
