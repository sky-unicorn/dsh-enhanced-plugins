import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Input, Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { z } from 'zod'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelRef } from '../shared.ts'
import type { NS } from './locales.ts'
import css from './Router.module.css'

/** Validate the public catalog at the transport boundary; preserve exact IDs. */
export const catalogSchema = z.object({ groups: z.array(z.object({ id: z.string(), name: z.string(), models: z.array(z.object({ id: z.string(), name: z.string() })) })), failures: z.array(z.object({ id: z.string(), name: z.string() })), routableProviders: z.array(z.string()) })
export type Catalog = z.infer<typeof catalogSchema>
export type LoadCatalog = (signal: AbortSignal) => Promise<Catalog>
type Localized = PropsLocale<typeof NS>
export const modelKey = (value: ModelRef) => JSON.stringify([value.provider, value.model])

export { CollaborationIcon } from './CollaborationIcon.tsx'

/** Add focus containment/restoration missing from the current public Modal. */
export function FocusDialog({ open, close, title, closeLabel, children }: { open: boolean; close: () => void; title: string; closeLabel: string; children: ReactNode }) {
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement
    const dialog = body.current?.closest<HTMLElement>('[role="dialog"]')
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [href], summary, [tabindex="0"]') ?? []).filter(el => el.getClientRects().length > 0)
    ;(body.current?.querySelector<HTMLInputElement>('input') ?? focusable()[0])?.focus()
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const items = focusable(), first = items[0], last = items.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    dialog?.addEventListener('keydown', trap)
    return () => { dialog?.removeEventListener('keydown', trap); if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [open])
  return <Modal open={open} onClose={close} title={title} closeLabel={closeLabel} className={css.dialog} contentClassName={css.dialogContent}><div ref={body}>{children}</div></Modal>
}

export function Choice({ label, value, options, onChange, disabled = false }: { label: string; value: string; options: { id: string; label: string }[]; onChange: (value: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  return <Menu open={open && !disabled} portal anchor={<Button variant="outline" disabled={disabled} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{options.find(option => option.id === value)?.label ?? label} ▾</Button>} items={options} selectedId={value} onClose={() => setOpen(false)} onSelect={id => { onChange(id); setOpen(false) }}/>
}

/** The three roles share one configured-only, searchable picker. */
export function ConfiguredModelPicker({ value, disabled, loadCatalog, onChange, t, label }: Localized & { value?: ModelRef; disabled: boolean; loadCatalog: LoadCatalog; onChange: (value: ModelRef) => void; label: string }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [catalog, setCatalog] = useState<Catalog>(), [error, setError] = useState(false), [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!open) return
    const abort = new AbortController(); setCatalog(undefined); setError(false); setQuery('')
    void loadCatalog(abort.signal).then(result => { if (!abort.signal.aborted) setCatalog(result) }).catch(() => { if (!abort.signal.aborted) setError(true) })
    return () => abort.abort()
  }, [open, retry, loadCatalog])
  const selected = catalog?.groups.flatMap(group => group.models.map(model => ({ ...model, provider: group.id }))).find(model => model.provider === value?.provider && model.id === value.model)
  const search = query.trim().toLocaleLowerCase()
  const groups = catalog?.groups.map(group => ({ ...group, models: group.models.filter(model => `${group.name} ${group.id} ${model.name} ${model.id}`.toLocaleLowerCase().includes(search)) })).filter(group => group.models.length)
  return <><Button className={css.modelButton} variant="outline" disabled={disabled} aria-label={label} onClick={() => setOpen(true)}><span><strong>{selected?.name ?? (value?.model || label)}</strong>{value?.provider && <small>{value.provider} / {value.model}</small>}</span><span aria-hidden="true">⌄</span></Button>
    <FocusDialog open={open} close={() => setOpen(false)} title={t('chooseModel')} closeLabel={t('close')}><div className={css.picker}>
      <Input aria-label={t('searchModels')} placeholder={t('searchModels')} value={query} onChange={event => setQuery(event.target.value)}/>
      <p className={css.muted}>{t('modelSettingsPath')}</p>
      {error ? <p role="alert">{t('unavailable')}</p> : !catalog ? <p role="status">{t('loading')}</p> : <>
        {!!catalog.failures.length && <p role="status">{t('partialCatalog')} {catalog.failures.map(group => group.name).join(' · ')}</p>}
        {value?.model && !selected && <p role="status">{t(catalog.routableProviders.includes(value.provider) ? 'notListed' : 'routeUnavailable')}: {value.provider} / {value.model}</p>}
        {!groups?.length && <p role="status">{t('noModels')}</p>}
        {groups?.map(group => <div className={css.pickerGroup} key={group.id}><h3>{group.name}</h3>{group.models.map(model => {
          const ref = { provider: group.id, model: model.id }, key = modelKey(ref), isSelected = !!value && modelKey(value) === key
          return <Button key={key} className={css.modelRow} aria-pressed={isSelected} disabled={disabled} onClick={() => { onChange(ref); setOpen(false) }}><span><strong>{model.name}</strong><small>{group.id} / {model.id}</small></span>{isSelected && <span aria-hidden="true">✓</span>}</Button>
        })}</div>)}
      </>}
      <Button variant="outline" onClick={() => setRetry(n => n + 1)}>{t('refresh')}</Button>
    </div></FocusDialog>
  </>
}
