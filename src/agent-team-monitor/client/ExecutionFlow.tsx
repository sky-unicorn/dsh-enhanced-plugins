import { useEffect, useId, useRef, useState } from 'react'
import clsx from 'clsx'
import type { ExecutionDetail, ExecutionNode, ExecutionTrace, MonitorSnapshot } from '../shared.ts'
import { CooperationFlow } from './CooperationFlow.tsx'
import type { MonitorInjected, MonitorPanelProps } from './Panel.tsx'
import css from './ExecutionFlow.module.css'

type Props = Pick<MonitorInjected, 'openMember' | 'inspectNode'> & { snapshot: MonitorSnapshot; t: MonitorPanelProps['t'] }
type Lane = { id: string; name: string; parentId?: string; trace?: ExecutionTrace; navigable: boolean }
const symbol = (node: ExecutionNode) => node.status === 'completed' ? '✓' : node.status === 'running' ? '◉' : node.status === 'failed' ? '!' : '○'

/** The graph orders recorded starts, not inferred dependencies or synthetic plans. */
export function ExecutionFlow({ snapshot, openMember, inspectNode, t }: Props) {
  const rootId = snapshot.kind === 'team' ? snapshot.teamId : snapshot.sessionId
  const [focus, setFocus] = useState<string>()
  const [view, setView] = useState<'cooperation' | 'steps'>('cooperation')
  const [expanded, setExpanded] = useState(false)
  const [filter, setFilter] = useState<'all' | 'running' | 'completed'>('all')
  const [selection, select] = useState<{ sessionId: string; seq: number }>()
  const [detail, setDetail] = useState<ExecutionDetail>()
  const [error, setError] = useState(false)
  const [navigationError, setNavigationError] = useState(false)
  const [requestVersion, retry] = useState(0)
  const detailId = useId()
  const detailRef = useRef<HTMLDivElement>(null)
  const names = new Map<string, string>()
  names.set(rootId, t('lead'))
  for (const member of snapshot.catalog?.sessions ?? []) names.set(member.id, member.label || member.title || t('unnamedMember'))
  if (snapshot.kind === 'team') for (const member of snapshot.members) names.set(member.id, member.name)
  if (snapshot.kind === 'team' || snapshot.kind === 'workflow') for (const run of snapshot.workflows?.runs ?? []) {
    for (const member of run.members) names.set(member.id, member.name)
  }
  const lanes: Lane[] = [{ id: rootId, name: t('lead'), trace: snapshot.execution, navigable: false }]
  const remaining = new Map([...(snapshot.catalog?.sessions ?? [])].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id)).map(row => [row.id, row]))
  const appendChildren = (parentId: string) => {
    for (const row of [...remaining.values()]) if (row.parentId === parentId) {
      remaining.delete(row.id)
      lanes.push({ id: row.id, parentId: row.parentId, name: names.get(row.id) || row.label || row.title || t('unnamedMember'), trace: row.execution, navigable: row.navigable })
      appendChildren(row.id)
    }
  }
  appendChildren(rootId)
  // Bounded native catalogs can omit an ancestor; keep its displayed descendants.
  for (const row of remaining.values()) lanes.push({ id: row.id, parentId: row.parentId,
    name: names.get(row.id) || row.label || row.title || t('unnamedMember'), trace: row.execution, navigable: row.navigable })
  const lane = lanes.find(row => row.id === selection?.sessionId)
  const transfer = snapshot.cooperation?.events.find(event => event.sessionId === selection?.sessionId && event.seq === selection?.seq)
  const node: ExecutionNode | undefined = lane?.trace?.nodes.find(item => item.seq === selection?.seq) ?? (transfer ? {
    seq: transfer.seq, kind: 'dispatch', turn: 0, status: transfer.outcome ?? (transfer.delivery === 'queued' ? 'running' : 'completed'), startedAt: transfer.time, endedAt: transfer.time,
  } : undefined)
  const selectedSession = node ? lane?.id : undefined
  const selectedSeq = node?.seq
  const endedAt = node?.endedAt
  const status = node?.status
  useEffect(() => {
    if (selectedSession !== undefined && (detail || error)) detailRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedSession, selectedSeq, detail, error])
  useEffect(() => {
    const visibility = () => retry(value => value + 1)
    document.addEventListener('visibilitychange', visibility)
    return () => document.removeEventListener('visibilitychange', visibility)
  }, [])
  // Refresh selected live payloads along with overview snapshots. Unmount, selection
  // changes, disconnect and hidden documents cancel work and reject stale replies.
  useEffect(() => {
    setDetail(undefined); setError(false)
    if (selectedSession === undefined || selectedSeq === undefined || !inspectNode || document.hidden) return
    const abort = new AbortController()
    let active = true
    const timeout = setTimeout(() => abort.abort(), 15_000)
    void inspectNode(rootId, selectedSession, selectedSeq, abort.signal).then(result => {
      if (active && !abort.signal.aborted) setDetail(result)
    }).catch(() => { if (active) setError(true) }).finally(() => clearTimeout(timeout))
    return () => { active = false; clearTimeout(timeout); abort.abort() }
  }, [rootId, selectedSession, selectedSeq, endedAt, status, inspectNode, requestVersion])
  const title = (item: ExecutionNode) => item.kind === 'tool' ? item.name ?? t('toolNode')
    : item.kind === 'dispatch' ? `${t('dispatchNode')} · ${item.name ?? t('unnamedMember')}`
      : item.kind === 'turn' ? `${t('turnNode')} ${item.turn}`
        : item.kind === 'step' ? `${t('stepNode')} ${item.turn}.${item.step}` : t('attemptNode')
  const duration = (item: ExecutionNode) => item.endedAt === undefined && item.status !== 'running' ? t('noEnd')
    : `${(Math.max(0, (item.endedAt ?? Date.now()) - item.startedAt) / 1000).toFixed(1)} ${t('seconds')}`
  const open = async (row: Lane) => {
    setNavigationError(false)
    try { await openMember(row.parentId ?? rootId, row.id) } catch { setNavigationError(true) }
  }
  const choose = (sessionId: string, seq: number) => { select({ sessionId, seq }); retry(value => value + 1) }
  const shown = lanes.filter(row => focus === undefined || focus === row.id)
  const total = lanes.reduce((sum, row) => sum + (row.trace?.total ?? 0), 0)
  const overview = (snapshot.catalog?.sessions.length ?? 0) > 0 && view === 'cooperation'
  const focusMember = (id: string) => { setFocus(id); setView('steps'); select(undefined) }
  return <section className={css.execution} aria-label={t('executionFlow')}>
    <div className={css.toolbar}>
      <div><h3>{t('executionFlow')}</h3><p>{t(overview ? 'cooperationSubtitle' : 'flowHint')}</p></div>
      {(snapshot.catalog?.sessions.length ?? 0) > 0 && <div className={css.viewTabs}>
        <button type="button" aria-pressed={overview} onClick={() => { setView('cooperation'); setFocus(undefined) }}>{t('cooperationView')}</button>
        <button type="button" aria-pressed={!overview} onClick={() => setView('steps')}>{t('internalView')}</button>
      </div>}
      {!overview && <>
      {focus !== undefined && <button type="button" onClick={() => setFocus(undefined)}>{t('allMembers')}</button>}
      <button type="button" aria-pressed={expanded} onClick={() => setExpanded(!expanded)}>{t('detailedNodes')}</button>
      <label>{t('nodeFilter')}<select value={filter} onChange={event => setFilter(event.target.value as typeof filter)}>
        <option value="all">{t('allSessions')}</option><option value="running">{t('running')}</option><option value="completed">{t('completed')}</option>
      </select></label>
      </>}
    </div>
    {overview ? <CooperationFlow snapshot={snapshot} names={names} t={t} focus={focusMember} select={event => choose(event.sessionId, event.seq)} /> : <>
    <div className={css.legend}>{(['running', 'completed', 'failed', 'interrupted', 'unknown'] as const).map(value =>
      <span key={value} data-status={value}>{t(value)}</span>)}</div>
    {total === 0 && <p className={css.notice}>{t('noExecution')}</p>}
    <div className={css.canvas} role="region" aria-label={t('executionFlow')} tabIndex={0}>
      {shown.map(row => {
        const trace = row.trace
        const nodes = (trace?.nodes ?? []).filter(item => (expanded || item.kind === 'step' || item.kind === 'dispatch'
          || item.kind === 'turn' && !trace?.nodes.some(child => child.turn === item.turn && child.kind === 'step'))
          && (filter === 'all' || item.status === filter))
        return <div className={css.lane} key={row.id} data-execution-lane={row.id}>
          <div className={css.laneHeader}>
            <button type="button" className={css.laneName} aria-label={`${t('focusMember')}: ${row.name}`} onClick={() => setFocus(row.id)}>{row.name}</button>
            <small title={row.id}>{row.id}</small>
            {row.parentId && <button type="button" className={css.parent} onClick={() => setFocus(row.parentId)} disabled={!lanes.some(item => item.id === row.parentId)}>
              ↳ {t('parentSession')}: {lanes.find(item => item.id === row.parentId)?.name ?? row.parentId}
            </button>}
            {row.navigable && <button type="button" onClick={() => { void open(row) }}>{t('openSession')}</button>}
          </div>
          <div className={css.track}>
            {trace?.truncated && <span className={css.notice}>{t('flowTruncated')} {trace.nodes.length}/{trace.total}</span>}
            {nodes.length === 0 && <span className={css.notice}>{t(trace === undefined ? 'sessionUnavailable' : 'noMatchingNodes')}</span>}
            {nodes.map((item, index) => <div className={css.nodeWrap} key={item.seq}>
              {index > 0 && <span className={css.arrow} aria-hidden="true">→</span>}
              <button type="button" data-status={item.status} data-execution-node={`${row.id}:${item.seq}`}
                className={clsx(css.node, selection?.sessionId === row.id && selection.seq === item.seq && css.selected)}
                aria-pressed={selection?.sessionId === row.id && selection.seq === item.seq} aria-controls={detailId}
                onClick={() => choose(row.id, item.seq)}>
                <span className={css.nodeTitle}>{title(item)}</span>
                <span className={css.status}>{symbol(item)} {t(item.status)}</span>
                <small>{new Date(item.startedAt).toLocaleTimeString()} · {duration(item)}</small>
              </button>
            </div>)}
          </div>
        </div>
      })}
    </div>
    </>}
    <div id={detailId} ref={detailRef} className={css.detail} aria-label={t('nodeDetails')}>
      {!node || !lane ? <p className={css.notice}>{t(selection ? 'nodeExpired' : 'selectNode')}</p> : <>
        <div className={css.detailHeader}><h3>{lane.name} / {transfer ? t(transfer.kind === 'return' ? 'returnStage' : transfer.kind === 'message' ? 'progressReports' : 'dispatchStage') : title(node)}</h3><span data-status={node.status}>{t(node.status)}</span></div>
        {transfer && <p className={css.notice}>{names.get(transfer.fromId) ?? transfer.fromId} → {names.get(transfer.toId) ?? transfer.toId} · {t(transfer.delivery === 'recorded' ? 'receiptRecorded' : 'receiptQueued')} · {t(`evidence_${transfer.source}`)}</p>}
        <dl className={css.facts}><div><dt>{t('startedAt')}</dt><dd>{new Date(node.startedAt).toLocaleString()}</dd></div>
          <div><dt>{t('endedAt')}</dt><dd>{node.endedAt === undefined ? t('noEnd') : new Date(node.endedAt).toLocaleString()}</dd></div>
          <div><dt>{t('duration')}</dt><dd>{duration(node)}</dd></div>
          {node.callId && <div><dt>{t('callId')}</dt><dd>{node.callId}</dd></div>}
        </dl>
        {(node.kind === 'step' || node.kind === 'turn') && <div className={css.children}>
          {lane.trace?.nodes.filter(item => item.seq !== node.seq && item.turn === node.turn
            && (node.kind === 'turn' || item.step === node.step && item.kind !== 'turn')).map(item =>
            <button type="button" key={item.seq} data-status={item.status} onClick={() => choose(lane.id, item.seq)}>{title(item)} · {t(item.status)}</button>)}
        </div>}
        {node.childId && <button type="button" disabled={!lanes.some(row => row.id === node.childId)} onClick={() => focusMember(node.childId!)}>{t('followDispatch')}</button>}
        {error ? <p role="alert">{t('detailError')}</p> : !detail && inspectNode ? <p role="status">{t('loadingDetail')}</p> : <div className={css.payloads}>
          <div><h4>{t('nodeInput')}</h4><pre>{detail?.input || t('noPayload')}</pre></div>
          <div><h4>{t('nodeOutput')}</h4><pre>{detail?.output || t('noPayload')}</pre></div>
        </div>}
        {detail?.truncated && <p className={css.notice}>{t('payloadTruncated')}</p>}
        {lane.navigable && <button type="button" onClick={() => { void open(lane) }}>{t('transcript')}</button>}
      </>}
    </div>
    {navigationError && <p role="alert">{t('navigationError')}</p>}
  </section>
}
