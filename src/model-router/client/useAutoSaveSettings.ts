import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { RouterConfig } from '../shared.ts'

const fields = ['enabled', 'models', 'limits', 'retry', 'routing'] as const
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Debounced, revision-fenced writes; rejected drafts require an edit or explicit reload. */
export function useAutoSaveSettings(scope: Pick<SettingsScope<RouterConfig>, 'getSnapshot' | 'subscribe' | 'mutate'>) {
  const snapshot = useSyncExternalStore(scope.subscribe.bind(scope), scope.getSnapshot.bind(scope))
  const [draft, setDraft] = useState<RouterConfig>()
  const [baseline, setBaseline] = useState<RouterConfig>()
  const [revision, setRevision] = useState<number>()
  const [message, setMessage] = useState<'saved' | 'saving' | 'pendingSave' | 'conflict' | 'saveError'>()
  const [busy, setBusy] = useState(false)
  const latestDraft = useRef(draft)
  latestDraft.current = draft
  const pending = useRef<() => void>()
  const writing = useRef(false)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; pending.current?.(); pending.current = undefined }
  }, [])
  useEffect(() => {
    if (snapshot.value && !writing.current && (!draft || equal(draft, baseline))) {
      setDraft(structuredClone(snapshot.value)); setBaseline(structuredClone(snapshot.value)); setRevision(snapshot.revision)
    }
  }, [snapshot])
  useEffect(() => {
    if (!draft || !baseline || revision === undefined) return
    const changed = fields.filter(field => !equal(draft[field], baseline[field]))
    if (!changed.length) return
    const save = async () => {
      pending.current = undefined
      if (writing.current) return
      const current = scope.getSnapshot()
      if (current.revision !== revision) { if (mounted.current) setMessage('conflict'); return }
      if (!current.writable) { if (mounted.current) setMessage('saveError'); return }
      writing.current = true
      if (mounted.current) { setBusy(true); setMessage('saving') }
      try {
        await scope.mutate(changed.map(field => ({ op: 'set' as const, path: [field], value: JSON.parse(JSON.stringify(draft[field])) })), revision)
        const result = scope.getSnapshot()
        const applied = fields.every(field => equal(result.value?.[field], draft[field]))
        if (mounted.current) {
          if (applied && result.value) { setDraft(structuredClone(result.value)); setBaseline(structuredClone(result.value)); setRevision(result.revision) }
          setMessage(applied ? 'saved' : result.revision !== revision ? 'conflict' : 'saveError')
        }
      } catch { if (mounted.current) setMessage(scope.getSnapshot().revision !== revision ? 'conflict' : 'saveError') }
      finally { writing.current = false; if (mounted.current) setBusy(false) }
    }
    pending.current = () => { void save() }
    const timer = setTimeout(() => pending.current?.(), 400)
    return () => { clearTimeout(timer); pending.current = undefined }
  }, [draft, baseline, revision, scope])
  const update = (fn: (next: RouterConfig) => void) => {
    const current = latestDraft.current
    if (!current || writing.current) return
    const next = structuredClone(current); fn(next)
    if (equal(next, current)) return
    latestDraft.current = next
    setDraft(next); setMessage(equal(next, baseline) ? undefined : 'pendingSave')
  }
  const reload = () => {
    const current = scope.getSnapshot()
    if (!current.value || writing.current) return
    setDraft(structuredClone(current.value)); setBaseline(structuredClone(current.value)); setRevision(current.revision); setMessage(undefined)
  }
  return { snapshot, draft, revision, message, busy, update, reload }
}
