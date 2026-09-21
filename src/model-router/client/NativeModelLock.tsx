import { useEffect, useState, type RefObject } from 'react'
import clsx from 'clsx'
import { createPortal } from 'react-dom'
import css from './Router.module.css'

const lockClass = css.nativeModelLocked!

/** Leave DSH's model seat and menu owned by DSH; temporarily cover its seat while managed. */
export function NativeModelLock({ anchor, active, label, title }: { anchor: RefObject<HTMLElement>; active: boolean; label: string; title: string }) {
  const [seat, setSeat] = useState<HTMLElement>()
  useEffect(() => {
    if (!active) { setSeat(undefined); return }
    // Public renderer anchors delimit the same composer's trailing controls.
    const trailing = anchor.current?.closest('[data-slot="conversation.input.right"]')?.parentElement
    if (!trailing) return
    let owned: HTMLElement | undefined
    const scan = () => {
      const candidate = trailing.querySelector<HTMLElement>(':scope > [data-slot="conversation.input.model"]') ?? undefined
      if (candidate !== owned) {
        owned?.classList.remove(lockClass)
        owned = candidate
        setSeat(candidate)
      }
      if (!owned) return
      // Close the native portal through its trigger, not by editing React's nodes.
      const trigger = owned.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')
      if (trigger?.getAttribute('aria-expanded') === 'true') trigger.click()
      owned.classList.add(lockClass)
    }
    scan()
    const observer = new MutationObserver(scan)
    observer.observe(trailing, { childList: true, subtree: true })
    return () => { observer.disconnect(); owned?.classList.remove(lockClass) }
  }, [anchor, active])
  if (!active || !seat) return null
  return createPortal(<button data-dsh-router-model-status="" className={clsx(css.composerButton, css.modelTrigger)} type="button" disabled aria-label={label} title={title}><span className={css.composerLabel}>{label}</span></button>, seat)
}
