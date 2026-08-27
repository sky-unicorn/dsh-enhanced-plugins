import { useMemo, useState } from 'react'
import clsx from 'clsx'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { IconUserOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MonitorSnapshot } from '../shared.ts'
import { groupRoleSessions } from './roles.ts'
import type { NS } from './locales.ts'
import css from './RoleSessions.module.css'

type Filter = 'allSessions' | 'runningSessions' | 'pastSessions'
export interface RoleSessionsProps extends PropsLocale<typeof NS> {
  snapshot: MonitorSnapshot
  openMember(parentId: string, memberId: string): Promise<void>
}

/** Role groups preserve distinct child sessions and route clicks through native navigation. */
export function RoleSessions({ snapshot, openMember, t }: RoleSessionsProps) {
  const groups = useMemo(() => groupRoleSessions(snapshot), [snapshot])
  const [filter, setFilter] = useState<Filter>('allSessions')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [opening, setOpening] = useState<string>()
  const [error, setError] = useState<string>()
  const catalog = snapshot.catalog
  if (catalog === undefined) return null
  const all = groups.flatMap(group => group.sessions)
  const running = all.filter(row => row.status === 'running').length
  const counts: Record<Filter, number> = { allSessions: all.length, runningSessions: running, pastSessions: all.length - running }
  const visible = groups.map(group => {
    const sessions = group.sessions.filter(row => filter === 'allSessions'
      || (filter === 'runningSessions' ? row.status === 'running' : row.status !== 'running'))
    return { ...group, sessions, running: sessions.filter(row => row.status === 'running').length }
  }).filter(group => group.sessions.length > 0)
  const open = async (parentId: string, id: string) => {
    if (opening !== undefined) return
    setOpening(id); setError(undefined)
    try { await openMember(parentId, id) } catch { setError(id) } finally { setOpening(undefined) }
  }
  return <section className={css.root} aria-label={t('roleSessions')}>
    <h3><IconUserOutline16 />{t('roleSessions')}<span>{groups.length}</span></h3>
    <p className={css.hint}>{t('roleHint')}</p>
    {catalog.state === 'unavailable' && <p role="status" className={css.warning}>{t('catalogUnavailable')}</p>}
    {catalog.truncated && <p className={css.warning}>{t('catalogTruncated')} {all.length} / {catalog.total}</p>}
    <div className={css.filters} role="group" aria-label={t('sessionFilter')}>
      {(['allSessions', 'runningSessions', 'pastSessions'] as const).map(value => <button key={value} type="button"
        className={clsx(css.filter, value === filter && css.selected)} aria-pressed={filter === value}
        onClick={() => setFilter(value)}>{t(value)}<span>{counts[value]}</span></button>)}
    </div>
    {filter === 'pastSessions' && <p className={css.hint}>{t('pastHint')}</p>}
    {visible.length === 0 && catalog.state === 'ready' && <p className={css.hint}>{t('noMatchingSessions')}</p>}
    {visible.map(group => <div key={group.key} className={css.group}>
      <button type="button" className={css.role} aria-expanded={!collapsed.has(group.key)}
        onClick={() => setCollapsed(current => { const next = new Set(current); if (next.has(group.key)) next.delete(group.key); else next.add(group.key); return next })}>
        <strong>{group.name ?? t('unknownRole')}</strong>
        <span>{t('sessions')}: {group.sessions.length}{group.running > 0 && <> · {t('running')}: {group.running}</>}</span>
      </button>
      {!collapsed.has(group.key) && <ul className={css.sessions}>
        {group.sessions.map(row => <li key={row.id}>
          <button type="button" className={css.session} disabled={!row.navigable || opening !== undefined}
            aria-label={`${t('openSession')}: ${row.title || row.id}`} aria-busy={opening === row.id}
            onClick={() => { void open(row.parentId, row.id) }}>
            <span className={css.dot} data-status={row.status} />
            <span className={css.content}>
              <span className={css.title}>{row.title || row.id}</span>
              {row.title && <span className={css.id}>{row.id}</span>}
              {row.workflow && <span className={css.meta}>{row.workflow}{row.phase !== undefined && <> · {row.phase}</>}</span>}
              <span className={css.meta}>{row.mode !== undefined && t(row.mode === 'one-shot' ? 'oneShot' : 'continuable')}
                {row.createdAt !== undefined && <> · {new Date(row.createdAt).toLocaleString()}</>}
              </span>
              {row.depth > 1 && <span className={css.meta}>{t('parentSession')}: {row.parentId}</span>}
              {row.diagnostic !== undefined && <span className={css.warning}>{t('sessionUnavailable')}</span>}
            </span>
            <span className={css.status} data-status={row.status}>{t(row.status)}</span>
          </button>
          {error === row.id && <p role="alert" className={css.warning}>{t('navigationError')}</p>}
        </li>)}
      </ul>}
    </div>)}
  </section>
}
