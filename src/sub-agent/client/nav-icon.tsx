import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { IconBranchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'

export const SUBAGENT_NAV_ICON_MARKER = 'data-dsh-sub-agent-nav-icon'

interface MountedNavIcon {
  button: HTMLButtonElement
  fallback: SVGSVGElement
  fallbackDisplay: string
  host: HTMLSpanElement
  root: Root
}

function directSvg(button: HTMLButtonElement): SVGSVGElement | undefined {
  return Array.from(button.children).find(child => child.tagName.toLowerCase() === 'svg') as SVGSVGElement | undefined
}

function touchesSettingsNavigation(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return false
  const element = node as Element
  return element.closest('[role="dialog"] nav') !== null
    || element.matches('[role="dialog"]')
    || element.querySelector('[role="dialog"] nav') !== null
}

/**
 * Replace the settings shell's unknown-section gear with the public branch
 * glyph until the settings.section contract gains an icon option.
 *
 * The shell currently projects only an entry's id and localized label into
 * DOM. Matching the exact labels owned by this plugin keeps the compatibility
 * shim local to its own row, while the observer repairs ordinary shell
 * remounts and locale changes. Disposal restores every fallback glyph.
 */
export function installSubagentNavIcon(labels: readonly string[]): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}

  const ownedLabels = new Set(labels)
  const mounted = new Map<HTMLButtonElement, MountedNavIcon>()

  const unmount = (entry: MountedNavIcon): void => {
    mounted.delete(entry.button)
    entry.root.unmount()
    entry.host.remove()
    if (entry.fallback.isConnected) entry.fallback.style.display = entry.fallbackDisplay
  }

  const scan = (): void => {
    for (const entry of mounted.values()) {
      const stillOwned = entry.button.isConnected
        && ownedLabels.has(entry.button.textContent?.trim() ?? '')
        && entry.host.isConnected
        && entry.fallback.isConnected
      if (!stillOwned) unmount(entry)
    }

    const buttons = document.querySelectorAll<HTMLButtonElement>('[role="dialog"] nav button')
    for (const button of buttons) {
      if (!ownedLabels.has(button.textContent?.trim() ?? '') || mounted.has(button)) continue
      const fallback = directSvg(button)
      if (fallback === undefined) continue

      const host = document.createElement('span')
      host.setAttribute(SUBAGENT_NAV_ICON_MARKER, '')
      host.style.display = 'contents'
      fallback.before(host)

      const fallbackDisplay = fallback.style.display
      fallback.style.display = 'none'
      const root = createRoot(host)
      root.render(createElement(IconBranchOutline16, {
        size: 16,
        className: fallback.getAttribute('class') ?? undefined,
      }))
      mounted.set(button, { button, fallback, fallbackDisplay, host, root })
    }
  }

  const observer = new MutationObserver((records) => {
    const relevant = records.some(record => touchesSettingsNavigation(record.target)
      || Array.from(record.addedNodes).some(touchesSettingsNavigation)
      || Array.from(record.removedNodes).some(touchesSettingsNavigation))
    if (relevant) scan()
  })
  observer.observe(document.body, { childList: true, subtree: true })
  scan()

  return () => {
    observer.disconnect()
    for (const entry of Array.from(mounted.values())) unmount(entry)
  }
}
