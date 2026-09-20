import { useId, type CSSProperties } from 'react'
import clsx from 'clsx'
import type { CooperationEvent, MonitorSnapshot } from '../shared.ts'
import type { MonitorPanelProps } from './Panel.tsx'
import { cooperationGroups } from './cooperation.ts'
import css from './CooperationFlow.module.css'

interface Props {
  snapshot: MonitorSnapshot
  names: ReadonlyMap<string, string>
  t: MonitorPanelProps['t']
  focus(id: string): void
  select(event: CooperationEvent): void
}
const ROW = 218
const position = (x: number, y: number) => ({ '--flow-x': `${x}px`, '--flow-y': `${y}px` } as CSSProperties)

/** Dispatch fan-out and explicit return fan-in, with each member's current recorded progress. */
export function CooperationFlow({ snapshot, names, t, focus, select }: Props) {
  const marker = useId().replace(/:/g, '')
  const groups = cooperationGroups(snapshot)
  const rows = groups.flatMap(group => group.members)
  const rootId = snapshot.kind === 'team' ? snapshot.teamId : snapshot.sessionId
  const name = (id: string) => id === rootId ? t('lead') : names.get(id) || t('unnamedMember')
  return <section className={css.overview} aria-label={t('cooperationView')}>
    <div className={css.summary}>
      <div><strong>{rows.length}</strong><span>{t('delegatedMembers')}</span></div>
      <div><strong>{rows.filter(row => row.status === 'running').length}</strong><span>{t('running')}</span></div>
      <div><strong>{rows.filter(row => row.status === 'completed').length}</strong><span>{t('executionDone')}</span></div>
      <div><strong>{rows.filter(row => row.received).length}<small> / {rows.length}</small></strong><span>{t('receivedCallbacks')}</span></div>
    </div>
    <p className={css.hint}>{t('cooperationHint')}</p>
    {snapshot.cooperation?.truncated && <p className={css.hint}>{t('cooperationTruncated')}</p>}
    <div className={css.viewport} role="region" aria-label={t('dispatchReturnGraph')} tabIndex={0}>
      {groups.map((group, groupIndex) => {
        const groupMarker = `${marker}-${groupIndex}`
        const height = group.members.length * ROW + 24
        const center = height / 2
        const received = group.members.filter(row => row.received).length
        return <div key={group.parentId} className={css.group} style={{ '--flow-height': `${height}px` } as CSSProperties} data-cooperation-group={group.parentId}>
          <svg className={css.edges} width="980" height={height} aria-hidden="true">
            <defs><marker id={`${groupMarker}-out`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" className={css.outArrow} /></marker>
              <marker id={`${groupMarker}-in`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" className={css.inArrow} /></marker></defs>
            {group.members.map((row, index) => {
              const y = index * ROW + 116
              return <g key={row.member.id}>
                <path className={clsx(css.outEdge, !row.dispatch && css.unrecorded)} d={`M 166 ${center} H 196 V ${y} H 252`} markerEnd={`url(#${groupMarker}-out)`} />
                <path className={clsx(css.inEdge, !row.received && css.unrecorded)} d={`M 658 ${y} H 738 V ${center} H 802`} markerEnd={row.received ? `url(#${groupMarker}-in)` : undefined} />
              </g>
            })}
          </svg>
          <button type="button" className={css.parentNode} style={position(12, center - 60)} onClick={() => focus(group.parentId)}>
            <span className={css.eyebrow}>{t('dispatchOwner')}</span><strong>{name(group.parentId)}</strong><span>{t('delegatedMembers')} · {group.members.length}</span>
          </button>
          <div className={css.receiverNode} style={position(810, center - 66)}>
            <span className={css.eyebrow}>{t('returnToParent')}</span><strong>{name(group.parentId)}</strong>
            <span>{t('receivedCallbacks')} <b>{received}/{group.members.length}</b></span>
            <span>{t('notReceived')} · {group.members.length - received}</span>
          </div>
          {group.members.map((row, index) => {
            const top = index * ROW + 16
            const p = row.progress
            const stepState = p?.status === 'running' ? 'running' : row.finished ? (p?.status === 'completed' ? 'completed' : 'failed') : 'unknown'
            const elapsed = p ? p.endedAt === undefined && p.status !== 'running' ? t('noEnd')
              : `${(Math.max(0, (p.endedAt ?? Date.now()) - p.startedAt) / 1000).toFixed(1)} ${t('seconds')}` : t('noExecution')
            return <div key={row.member.id}>
              <button type="button" disabled={!row.dispatch} className={css.edgeLabel} style={position(176, top + 70)} onClick={() => row.dispatch && select(row.dispatch)}>
                {t(row.dispatch ? 'dispatched' : 'noDispatchRecord')}
              </button>
              <article className={css.memberNode} style={position(258, top)} data-cooperation-member={row.member.id} data-status={row.status}>
                <header><button type="button" onClick={() => focus(row.member.id)} aria-label={`${t('focusMember')}: ${name(row.member.id)}`}>{name(row.member.id)}</button>
                  <span className={css.badge} data-status={row.status}>{t(row.status)}</span></header>
                <div className={css.phase}>{row.phase ?? row.member.label ?? row.member.title ?? t('noPhase')}</div>
                <div className={css.stages} aria-label={t('memberProgress')}>
                  <span data-state={row.dispatch ? 'completed' : 'unknown'}>{t('dispatchStage')}</span>
                  <span data-state={stepState}>{t('executeStage')}</span>
                  <span data-state={row.result ? 'completed' : 'unknown'}>{t('returnStage')}</span>
                  <span data-state={row.received ? 'completed' : 'unknown'}>{t('receiveStage')}</span>
                </div>
                <div className={css.current}>{p?.current ? `${t('currentOperation')}: ${p.current.kind === 'tool' ? p.current.name ?? t('toolNode') : t('modelStep')}`
                  : row.status === 'completed' ? t(row.received ? 'callbackReceived' : 'completedWithoutCallback') : t(row.status)}</div>
                <div className={css.counts}>
                  <span>{t('stepsCompleted')} <b>{p?.completedSteps ?? 0}</b> / {p?.steps ?? 0}</span>
                  <span>{t('toolsCompleted')} <b>{p?.completedTools ?? 0}</b> / {p?.tools ?? 0}</span>
                  {(p?.failedTools ?? 0) > 0 && <span>{t('failed')} · {p!.failedTools}</span>}
                  <span>{elapsed}</span>
                </div>
                <footer><button type="button" onClick={() => focus(row.member.id)}>{t('inspectExecution')}</button>
                  {row.messages.length > 0 && <button type="button" onClick={() => select(row.messages.at(-1)!)}>{t('progressReports')} · {row.messages.length}</button>}
                  {row.result && <button type="button" onClick={() => select(row.result!)}>{t('inspectCallback')}</button>}
                </footer>
              </article>
              <button type="button" className={clsx(css.edgeLabel, css.returnLabel)} style={position(670, top + 69)} disabled={!row.result} onClick={() => row.result && select(row.result)} data-callback-state={row.received ? 'received' : 'unrecorded'}>
                {t(row.received ? 'callbackReceived' : row.status === 'running' ? 'awaitingReturn' : 'noReturnRecord')}
                {row.result && <small>{new Date(row.result.time).toLocaleTimeString()}</small>}
              </button>
            </div>
          })}
        </div>
      })}
    </div>
    <p className={css.hint}>{t('progressDenominator')}</p>
  </section>
}
