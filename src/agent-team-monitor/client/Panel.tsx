import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import clsx from 'clsx'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { IconUserOutline16, IconChecklistOutline14, IconCloseOutline16, IconRefreshOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MonitorState } from './controller.ts'
import type { MonitorTask, TeamSnapshot, WorkflowActivity } from '../shared.ts'
import { layoutTasks } from './graph.ts'
import { RoleSessions } from './RoleSessions.tsx'
import { NS } from './locales.ts'
import css from './Panel.module.css'

export interface MonitorInjected {
  hooks: { teamMonitor: SnapshotStore<MonitorState> }
  setOpen(open: boolean): void
  refresh(): void
  openMember(teamId: string, memberId: string): Promise<void>
}
type ViewProps = InjectFace<MonitorInjected> & PropsLocale<typeof NS>
export type MonitorControlProps = PropsRuntime<'conversation.input.right'> & ViewProps
export type MonitorPanelProps = ViewProps & { sessionId: string; panelId?: string; close(): void; style?: CSSProperties }

/** Session-owned icon and anchored popover; ordinary conversations contribute no chrome. */
export function MonitorControl(props: MonitorControlProps) {
  const { useTeamMonitor, sessionId, setOpen, t } = props
  const state = useTeamMonitor(value => value)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const [position, setPosition] = useState<CSSProperties>()
  const available = state.sessionId === sessionId && state.detected
  const close = () => { setOpen(false); trigger.current?.focus() }
  useLayoutEffect(() => {
    if (!available || !state.open) return
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (rect === undefined) return
      const width = Math.min(440, window.innerWidth - 24)
      setPosition({ '--monitor-left': `${Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))}px`,
        '--monitor-bottom': `${Math.max(12, window.innerHeight - rect.top + 8)}px`,
        '--monitor-height': `${Math.max(100, rect.top - 20)}px` } as CSSProperties)
    }
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus() }
    }
    place()
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', key)
    }
  }, [available, state.open, setOpen, sessionId])
  if (!available) return null
  return <div ref={root} className={css.control} data-team-monitor-session={sessionId}>
    <button ref={trigger} type="button" className={clsx(css.trigger, state.open && css.selected)} title={t('open')}
      aria-label={t('open')} aria-haspopup="dialog" aria-expanded={state.open} aria-controls={state.open ? panelId : undefined}
      onClick={() => setOpen(!state.open)}><IconUserOutline16 /></button>
    <MonitorPanel {...props} panelId={panelId} close={close} style={position} />
  </div>
}

function WorkflowBody({ activity, sessionId, t, openMember }: {
  activity: WorkflowActivity; sessionId: string; t: ViewProps['t']; openMember: MonitorInjected['openMember']
}) {
  const [navigationError, setNavigationError] = useState(false)
  const open = async (id: string) => {
    setNavigationError(false)
    try { await openMember(sessionId, id) } catch { setNavigationError(true) }
  }
  return <section className={css.section}>
    <h3><IconUserOutline16 />{t('workflows')}<span>{activity.counts.runs}</span></h3>
    <p className={css.notice}>{t('workflowHint')}</p>
    <div className={css.metrics}>
      <div><strong>{activity.counts.members}</strong><span>{t('startedMembers')}</span></div>
      <div><strong>{activity.counts.running}</strong><span>{t('running')}</span></div>
      <div><strong>{activity.counts.completed}</strong><span>{t('completed')}</span></div>
    </div>
    {activity.truncated && <p className={css.notice}>{t('workflowTruncated')}</p>}
    {activity.runs.map(run => <div key={run.id} className={css.workflow}>
      <div className={css.memberTitle}><strong>{run.name || t('unnamedWorkflow')}</strong><span className={css.status} data-status={run.status}>{t(run.status)}</span></div>
      {run.members.length === 0 && <p className={css.empty}>{t('noWorkflowMembers')}</p>}
      {run.members.map(member => <div key={member.seq} className={css.member}>
        <span className={css.dot} data-status={member.status} />
        <div className={css.memberContent}>
          <div className={css.memberTitle}>
            <button type="button" className={css.memberLink} aria-label={`${t('transcript')}: ${member.name || t('unnamedMember')}`}
              onClick={() => { void open(member.id) }}>{member.name || t('unnamedMember')}</button>
            <span className={css.status} data-status={member.status}>{t(member.status)}</span>
          </div>
          <div className={css.meta}>{t('phase')}: {member.phase ?? t('noPhase')}</div>
          <div className={css.meta}>{member.model ?? t('noModel')}</div>
        </div>
      </div>)}
    </div>)}
    {navigationError && <p role="alert" className={css.warning}>{t('navigationError')}</p>}
    <p className={css.footer}>{t('synced')}: {new Date(activity.lastActivityAt).toLocaleString()}</p>
  </section>
}

function taskLabel(task: MonitorTask) {
  return task.status === 'pending' && task.ready ? 'ready' : task.status === 'pending' && task.blockedBy.length > 0 ? 'blocked' : task.status
}

function TeamBody({ snapshot, t, openMember }: { snapshot: TeamSnapshot; t: ViewProps['t']; openMember: MonitorInjected['openMember'] }) {
  const [selectedId, select] = useState<string>()
  const [navigationError, setNavigationError] = useState(false)
  const [membersOpen, setMembersOpen] = useState(true)
  const graph = useMemo(() => {
    try { return layoutTasks(snapshot.tasks) } catch { return undefined }
  }, [snapshot.tasks])
  const task = snapshot.tasks.find(item => item.id === selectedId)
  const open = async (memberId: string) => {
    setNavigationError(false)
    try { await openMember(snapshot.teamId, memberId) } catch { setNavigationError(true) }
  }
  return <>
    <div className={css.metrics}>
      <div><strong>{snapshot.counts.completed}<small> / {snapshot.counts.tasks}</small></strong><span>{t('completed')}</span></div>
      <div><strong>{snapshot.counts.blocked}</strong><span>{t('blocked')}</span></div>
      <div><strong>{snapshot.counts.pendingMessages}</strong><span>{t('mailbox')}</span></div>
    </div>
    <progress className={css.progress} value={snapshot.counts.completed} max={Math.max(snapshot.counts.tasks, 1)} aria-label={t('completed')} />
    {snapshot.source === 'persisted' && <p className={css.notice}>{t('history')}</p>}
    {!snapshot.enabled && <p className={css.notice}>{t('disabled')}</p>}
    {snapshot.truncated && <p className={css.notice}>{t('truncated')}</p>}
    <section className={css.section}>
      <h3><IconUserOutline16 />{t('members')}<span>{snapshot.counts.members}</span>
        <button type="button" className={css.memberToggle} aria-expanded={membersOpen} onClick={() => setMembersOpen(!membersOpen)}>{t(membersOpen ? 'collapseMembers' : 'expandMembers')}</button>
      </h3>
      {membersOpen && <div className={css.members}>
        {snapshot.members.map(member => <div key={member.id} className={css.member}>
          <span className={css.dot} data-status={member.status} />
          <div className={css.memberContent}>
            <div className={css.memberTitle}>
              {member.role === 'lead' ? <strong>{t('lead')}</strong> : <button type="button" className={css.memberLink}
                aria-label={`${t('transcript')}: ${member.name}`} onClick={() => { void open(member.id) }}>{member.name}</button>}
              <span className={css.status} data-status={member.status}>{t(member.status)}</span>
            </div>
            {member.description && <p>{member.description}</p>}
            <div className={css.meta}>{member.model ?? t('noModel')}{member.context && <span> · {t(member.context)}</span>}</div>
            {snapshot.tasks.filter(item => item.ownerName === member.name && item.status === 'in_progress').map(item =>
              <button type="button" key={item.id} className={css.assignment} onClick={() => select(item.id)}>{item.subject}</button>)}
            {member.pendingMessages > 0 && <div className={css.meta}>{t('mailbox')}: {member.pendingMessages}</div>}
            {member.diagnosticCount > 0 && <p className={css.warning}>{t('warning')}</p>}
          </div>
        </div>)}
      </div>}
      {navigationError && <p role="alert" className={css.warning}>{t('navigationError')}</p>}
    </section>
    <section className={css.section}>
      <h3><IconChecklistOutline14 />{t('tasks')}<span>{snapshot.counts.tasks}</span></h3>
      {snapshot.tasks.length === 0 ? <p className={css.empty}>{t('noTasks')}</p> : graph === undefined ? <p role="alert">{t('incompatible')}</p> : <>
        <div className={css.graphScroll} role="region" aria-label={t('tasks')} tabIndex={0}>
          <div className={css.graph} style={{ '--team-width': `${graph.width}px`, '--team-height': `${graph.height}px` } as CSSProperties}>
            <svg className={css.edges} width={graph.width} height={graph.height} aria-hidden="true">
              {graph.edges.map(edge => <path key={edge.key} d={edge.path} className={clsx(css.edge,
                (edge.from === selectedId || edge.to === selectedId) && css.activeEdge)} />)}
            </svg>
            {graph.nodes.map(node => <button type="button" key={node.task.id}
              className={clsx(css.task, selectedId === node.task.id && css.selected)} data-status={node.task.status}
              aria-pressed={selectedId === node.task.id} title={node.task.subject}
              style={{ '--team-x': `${node.x}px`, '--team-y': `${node.y}px` } as CSSProperties}
              onClick={() => select(node.task.id)}>
              <span className={css.taskTitle}>{node.task.subject}</span>
              <span className={css.taskMeta}>{t(taskLabel(node.task))} · {node.task.ownerName ?? t('unassigned')}</span>
            </button>)}
          </div>
        </div>
        {task === undefined ? <p className={css.empty}>{t('taskHint')}</p> : <div className={css.taskDetail}>
          <div className={css.memberTitle}><strong>{task.subject}</strong><span className={css.meta}>{t('revision')} {task.revision}</span></div>
          <p>{task.description}</p>
          <div className={css.meta}>{task.id} · {task.ownerName ?? t('unassigned')} · {t(taskLabel(task))}</div>
          {task.blockedBy.length > 0 && <p className={css.meta}>{t('dependencies')}: {task.blockedBy.map(id => <button type="button" key={id}
            className={css.dependency} onClick={() => select(id)}>{id}</button>)}</p>}
          {task.writeScopes.length > 0 && <div className={css.scopes}><span>{t('scopes')}</span>{task.writeScopes.map(scope => <code key={scope}>{scope}</code>)}</div>}
          {task.overlappingTaskIds.length > 0 && <p className={css.warning}>{t('overlap')}: {task.overlappingTaskIds.join(', ')}. {t('scopeHint')}</p>}
        </div>}
      </>}
    </section>
    <p className={css.footer}>{t('synced')}: {new Date(snapshot.lastActivityAt).toLocaleString()}</p>
  </>
}

/** Non-modal dialog rendered by its session's composer, never a global shell overlay. */
export function MonitorPanel({ useTeamMonitor, sessionId, panelId, close, style, refresh, openMember, t }: MonitorPanelProps) {
  const state = useTeamMonitor(value => value)
  const snapshot = sessionId === state.sessionId ? state.snapshot : undefined
  if (!state.open || !state.detected || sessionId !== state.sessionId) return null
  let notice = state.failed ? t('error') : !state.online ? t('offline') : t('loading')
  if (snapshot?.kind === 'unavailable') {
    notice = !snapshot.enabled && snapshot.reason === 'not-team' ? t('disabled')
      : snapshot.reason === 'not-team' ? t('noTeam')
        : snapshot.reason === 'incompatible' ? t('incompatible')
          : snapshot.reason === 'no-session' ? t('missing') : t('storage')
  }
  return <aside id={panelId} className={css.panel} style={style} role="dialog" aria-label={t('title')}>
    <header className={css.header}>
      <div><h2>{t('title')}</h2><p>{t('subtitle')}</p></div>
      {snapshot !== undefined && snapshot.kind !== 'unavailable' && <span className={css.source} data-live={snapshot.source === 'live'}>{t(snapshot.source)}</span>}
      <button type="button" className={css.iconButton} onClick={refresh} disabled={state.loading || !state.online} aria-label={t('refresh')} title={t('refresh')}><IconRefreshOutline16 /></button>
      <button type="button" className={css.iconButton} onClick={close} aria-label={t('close')} title={t('close')}><IconCloseOutline16 /></button>
    </header>
    <div className={css.body} aria-busy={state.loading && snapshot === undefined}>
      {snapshot !== undefined && <RoleSessions key={`${sessionId}:${snapshot.catalog?.scopeId ?? ''}`} snapshot={snapshot} openMember={openMember} t={t} />}
      {snapshot?.kind === 'team' && <TeamBody key={snapshot.teamId} snapshot={snapshot} t={t} openMember={openMember} />}
      {(snapshot?.kind === 'team' || snapshot?.kind === 'workflow') && snapshot.workflows !== undefined
        && (snapshot.catalog?.sessions.length ? <details className={css.domainDetails}>
          <summary>{t('workflowDetails')}</summary>
          <WorkflowBody key={sessionId} activity={snapshot.workflows} sessionId={sessionId} t={t} openMember={openMember} />
        </details> : <WorkflowBody key={sessionId} activity={snapshot.workflows} sessionId={sessionId} t={t} openMember={openMember} />)}
      {(snapshot === undefined || snapshot.kind === 'unavailable') && <p className={css.empty} role="status">{notice}</p>}
      <p className={css.footer}>{t('readonly')}</p>
    </div>
  </aside>
}
