import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { ledger, reportedTotal } from '../accounting.ts'
import type { ChildTask, RunRecord, TaskReport } from '../shared.ts'
import type { NS } from './locales.ts'
import { summarizeModelCalls } from './model-summary.ts'
import css from './Router.module.css'

type Localized = PropsLocale<typeof NS>
const number = (value: number) => value.toLocaleString()

/** One reading flow for current and historical runs; technical evidence stays expandable. */
export function RunDetails({ run, t, historical = false }: { run: RunRecord; historical?: boolean } & Localized) {
  const totals = ledger(run)
  const models = summarizeModelCalls(run)
  const unconfirmed = run.requests.filter(request => !request.actualModel).length
  const pendingUsage = run.requests.filter(request => request.status !== 'settled' && reportedTotal(request) === undefined).length
  return <div className={css.details}>
    <div className={css.runHeader}>
      <div><strong>{t(historical ? 'runDetails' : 'currentRun')}</strong><p className={css.muted}>{new Date(run.createdAt).toLocaleString()}</p></div>
      <span className={css.statusBadge} data-status={run.status}>{t(run.status === 'completed' ? 'executionEnded' : run.status)}</span>
    </div>
    <div className={css.metricGrid} role="group" aria-label={t('runSummary')}>
      <div className={css.metric}><strong>{models.length}</strong><span>{t('calledModels')}</span></div>
      <div className={css.metric}><strong>{number(run.requests.length)}</strong><span>{t('requests')}</span></div>
      <div className={css.metric}><strong>{totals.reported || (!totals.unknownRequests && !pendingUsage) ? number(totals.reported) : '—'}</strong><span>{t('reportedTokens')}</span></div>
    </div>
    {!!(totals.unknownRequests || pendingUsage) && <p className={css.muted}>{t('unknownRequests')}: {totals.unknownRequests} · {t('pendingUsage')}: {pendingUsage}</p>}
    {run.blockedReason && <p role="status" className={css.notice}>{t(['request-limit', 'token-limit', 'token-capability'].includes(run.blockedReason) ? 'legacyLimit' : 'recordLimit')}</p>}
    <section className={css.modelSummary} aria-label={t('modelCalls')}>
      <h3>{t('modelCalls')}</h3>
      {!models.length ? <p className={css.muted}>{t('noModelCalls')}</p> : <div className={css.modelUsageList}>{models.map(item => <div className={css.modelUsageRow} key={item.key}>
        <div className={css.modelRoute}><strong>{item.model.model}</strong><span>{item.model.provider}</span><div className={css.roleChips}>{item.roles.map(role => <span key={role}>{t(role)}</span>)}</div></div>
        <div className={css.callCount}><strong>{item.calls} {t('calls')}</strong><span>{item.reported || !item.unknownUsage ? `${number(item.reported)} ${t('tokenUnit')}` : t('usageUnknown')}{item.unknownUsage > 0 && item.reported > 0 ? ` · ${t('partialUsage')}` : ''}</span></div>
      </div>)}</div>}
      {!!unconfirmed && <p className={css.muted}>{t('unconfirmedCalls')}: {unconfirmed}</p>}
    </section>
    <section className={css.timeline} aria-label={t('taskTimeline')}>
      <div className={css.sectionTitle}><h3>{t('taskTimeline')}</h3><span className={css.muted}>{t('children')} {run.childExecutions}</span></div>
      {!run.tasks.length && <p className={css.muted}>{t(run.status === 'running' ? 'directHandling' : 'directHandled')}</p>}
      {run.tasks.map(task => <TaskRow key={task.id} task={task} run={run} t={t}/>)}
      <Acceptance report={run.report} stale={run.tasks.some(task => task.freshness === 'stale')} t={t}/>
      {run.decision && <p className={css.muted}>{t('decisionReason')} · {run.decision.reason}</p>}
    </section>
    <details className={css.fold}><summary>{t('requestDetails')} · {run.requests.length}</summary>
      <div className={css.foldBody}>
        <p className={css.muted}>{t('usageScope')}</p>
        <p className={css.muted}>{t('runId')} · {run.id}</p>
        {[...run.requests].reverse().map(request => <details className={css.requestRow} key={request.id}>
          <summary><span>{(request.actualModel ?? request.selectedModel).model}</span><span className={css.muted}>{t(request.actualModel ? 'actual' : 'unconfirmedModel')} · {new Date(request.time).toLocaleTimeString()}</span></summary>
          <div className={css.foldBody}>
            <p>{(request.actualModel ?? request.selectedModel).provider}/{(request.actualModel ?? request.selectedModel).model}</p>
            <p>{request.purpose && `${t(request.purpose)} · `}{request.reason && t(request.reason)}{request.failureKind && ` · ${t(request.failureKind)} (${request.failureCode ?? ''})`}</p>
            <p>{t('reportedTokens')}: {reportedTotal(request) === undefined ? t('usageUnknown') : number(reportedTotal(request)!)}</p>
            {request.usage && <details><summary>{t('usageDetails')}</summary><pre className={css.result}>{JSON.stringify(request.usage, null, 2)}</pre></details>}
            <code>{request.id}</code>
          </div>
        </details>)}
      </div>
    </details>
  </div>
}

function TaskRow({ task, run, t }: { task: ChildTask; run: RunRecord } & Localized) {
  const executions = task.executions ?? []
  const actualModels = [...new Set(run.requests.filter(request => request.actualModel && (request.executionId === task.executionId || executions.some(execution => execution.id === request.executionId))).map(request => `${request.actualModel!.provider}/${request.actualModel!.model}`))]
  return <article className={css.taskRow}>
    <div className={css.taskMarker} aria-hidden="true"/>
    <div className={css.taskBody}>
      <div className={css.taskHeader}><strong>{task.title}</strong><span className={css.statusBadge} data-status={task.status}>{t(task.status === 'completed' ? 'executionEnded' : task.status)}</span></div>
      <div className={css.taskMeta}><span>{t(task.role)}</span><span>{actualModels.length ? actualModels.join(' → ') : `${t('proposed')} · ${task.selectedModel.provider}/${task.selectedModel.model}`}</span></div>
      {task.freshness && task.freshness !== 'current' && <p role="status" className={css.notice}>{t(task.freshness === 'stale' ? 'staleResult' : 'unverifiableResult')}</p>}
      <details className={css.inlineDetails}><summary>{t('result')}</summary>
        <div className={css.foldBody}>
          <p>{t('decisionReason')} · {task.reason || t('reasonMissing')}</p>
          <Acceptance report={task.report} needsReview={!!task.report && task.report.reviewedBy !== run.sessionId} stale={task.freshness === 'stale'} t={t}/>
          {task.reviewDecision && <p role="status">{t(task.reviewDecision)}</p>}
          {task.result && <p className={css.result}>{task.result}</p>}
          {!!executions.length && <details className={css.inlineDetails}><summary>{t('executionHistory')} · {task.escalations ?? 0}</summary><div className={css.foldBody}>
            {executions.map(execution => <div className={css.executionRow} key={execution.id}>
              <strong>{t(execution.overridden ? 'manualOverride' : execution.reason)}</strong>
              <span>{t(execution.actualModel ? 'actual' : 'unconfirmedModel')} · {(execution.actualModel ?? execution.selectedModel).provider}/{(execution.actualModel ?? execution.selectedModel).model} · {t(execution.status === 'completed' ? 'executionEnded' : execution.status)}</span>
              <code>{execution.id}</code>
              {execution.childSessionId && <span>{t('childSession')} · {execution.childSessionId}</span>}
              {execution.result && <p className={css.result}>{execution.result}</p>}
              {execution.handoff && <details><summary>{t('handoff')}</summary><pre className={css.result}>{execution.handoff}</pre></details>}
            </div>)}
            {task.reviews?.map(review => <div className={css.executionRow} key={review.verification}><strong>{review.acceptanceId} · {t(review.category)}</strong><p>{review.explanation}</p><code>{review.baseline} → {review.action} → {review.verification}</code></div>)}
          </div></details>}
          {!!task.evidence?.length && <details className={css.inlineDetails}><summary>{t('evidenceRefs')}</summary><div className={css.foldBody}>{task.evidence.map(evidence => <div className={css.executionRow} key={evidence.id}><code>{evidence.id}</code><span>{evidence.tool} · {evidence.callId} · {t(evidence.failed ? 'failed' : 'completed')}</span><span>{t('childSession')} · {evidence.sessionId}</span></div>)}</div></details>}
        </div>
      </details>
    </div>
  </article>
}

/** Ending an execution never implies model-authored acceptance has passed. */
function Acceptance({ report, stale, needsReview, t }: { report?: TaskReport; stale?: boolean; needsReview?: boolean } & Localized) {
  if (!report) return <p className={css.muted}>{t('acceptanceMissing')}</p>
  const passed = !stale && !report.remaining.length && report.acceptance.every(item => item.status === 'passed')
  return <details className={css.inlineDetails}><summary>{t(needsReview ? 'acceptanceNeedsReview' : passed ? 'acceptancePassed' : 'acceptancePending')}</summary>
    <div className={css.foldBody}>
      <p>{report.summary}</p>{stale && <p role="status">{t('staleResult')}</p>}
      {report.acceptance.map(item => <div className={css.executionRow} key={item.id}><strong>{item.id} · {item.condition}</strong>
        <p>{t(stale ? 'acceptanceUnverified' : item.status === 'passed' ? 'acceptancePassed' : item.status === 'failed' ? 'acceptanceFailed' : 'acceptanceUnverified')} · {t(item.method === 'tool' ? 'toolVerification' : 'reasoningVerification')}</p>
        <p>{item.explanation}</p>{item.evidence.map(ref => <code key={ref}>{ref}</code>)}
      </div>)}
      {!!report.changes.length && <p>{t('reportedChanges')} · {report.changes.join('、')}</p>}
      {!!report.remaining.length && <p>{t('remainingWork')} · {report.remaining.join('、')}</p>}
    </div>
  </details>
}
