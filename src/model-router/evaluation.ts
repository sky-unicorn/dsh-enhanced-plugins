import { z } from 'zod'
import { runSchema } from './schema.js'
import { ledger } from './accounting.js'

const sampleSchema = z.object({
  task: z.string().min(1), repetition: z.number().int().min(1), group: z.enum(['normal', 'strong', 'auto']),
  inputHash: z.string().min(1), workspaceHash: z.string().min(1), environment: z.string().min(1),
  elapsedMs: z.number().finite().nonnegative(), passed: z.boolean(), evidence: z.string().min(1), run: runSchema,
}).strict()
export const evaluationSchema = z.object({
  kind: z.enum(['deterministic-fixture', 'real-model']), pluginRevision: z.string().min(1), dshRevision: z.string().min(1),
  samples: z.array(sampleSchema).min(3).max(1000),
}).strict()
export type Evaluation = z.infer<typeof evaluationSchema>

/** Compare matched trials only. Unknown usage and different currencies stay separate. */
export function evaluate(input: unknown) {
  const data = evaluationSchema.parse(input)
  const trials = new Map<string, Evaluation['samples']>()
  for (const sample of data.samples) {
    if (sample.passed && sample.run.status !== 'completed') throw new Error('Passing trial requires a completed run.')
    if (sample.group !== 'auto') {
      const expected = sample.run.config.models[sample.group]
      if (sample.run.requests.some(r => { const m = r.actualModel ?? r.selectedModel; return m.provider !== expected.provider || m.model !== expected.model || r.reason !== 'manual_fixed' })) throw new Error('Fixed group contains a different route.')
    } else if (sample.run.requests.some(r => r.reason === 'manual_fixed')) throw new Error('Automatic group contains manual routing.')
    const key = JSON.stringify([sample.task, sample.repetition])
    const trial = trials.get(key) ?? []
    if (trial.some(s => s.group === sample.group)) throw new Error('Duplicate trial group.')
    if (trial.some(s => s.inputHash !== sample.inputHash || s.workspaceHash !== sample.workspaceHash || s.environment !== sample.environment || JSON.stringify(s.run.config.models) !== JSON.stringify(sample.run.config.models))) throw new Error('Trial inputs or environment differ.')
    trial.push(sample); trials.set(key, trial)
  }
  if ([...trials.values()].some(t => t.length !== 3)) throw new Error('Each trial requires normal, strong and auto groups.')
  const groups = (['normal', 'strong', 'auto'] as const).map(group => {
    const rows = data.samples.filter(s => s.group === group)
    const durations = rows.map(s => s.elapsedMs).sort((a, b) => a - b)
    let reportedTokens = 0, unknownAttempts = 0, requests = 0, childExecutions = 0, upgraded = 0, upgradedPassed = 0, direct = 0
    const modelAttempts: Record<string, number> = {}
    for (const row of rows) {
      for (const request of row.run.requests) { const m = request.actualModel ?? request.selectedModel; const key = `${m.provider}/${m.model}`; modelAttempts[key] = (modelAttempts[key] ?? 0) + 1 }
      const usage = ledger(row.run)
      reportedTokens += usage.reported; unknownAttempts += usage.unknownRequests + row.run.requests.filter(r => r.status !== 'settled').length
      requests += row.run.requests.length; childExecutions += row.run.childExecutions
      if (!row.run.childExecutions) direct++
      if (row.run.tasks.some(t => (t.escalations ?? 0) > 0)) { upgraded++; if (row.passed) upgradedPassed++ }
    }
    return { group, samples: rows.length, passed: rows.filter(s => s.passed).length, passRate: rows.filter(s => s.passed).length / rows.length,
      elapsedMs: { min: durations[0], median: durations[Math.floor(durations.length / 2)], max: durations.at(-1) },
      reportedTokens, unknownAttempts, requests, modelAttempts, childExecutions, upgraded, upgradedPassed, direct }
  })
  return { kind: data.kind, pluginRevision: data.pluginRevision, dshRevision: data.dshRevision, trials: trials.size, groups,
    limitations: data.kind === 'deterministic-fixture' ? 'Routing/accounting integration only; scripted adapters cannot measure commercial model quality, latency or savings.' : 'Only the supplied matched trials; unknown usage is excluded from reported totals.' }
}
