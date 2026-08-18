// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconBranchOutline16: ({ size = 16, className }: { size?: number; className?: string }) => (
    <svg width={size} height={size} className={className}><path d="M1 1h14v14z" /></svg>
  ),
}))

import { installSubagentNavIcon, SUBAGENT_NAV_ICON_MARKER } from '../../src/sub-agent/client/nav-icon.tsx'

function settingsButton(label: string, className = 'nav-icon'): HTMLButtonElement {
  const dialog = document.createElement('div')
  dialog.setAttribute('role', 'dialog')
  dialog.innerHTML = `<nav><button><svg class="${className}" data-fallback="true"></svg><span></span></button></nav>`
  const button = dialog.querySelector('button') as HTMLButtonElement
  const span = button.querySelector('span') as HTMLSpanElement
  span.textContent = label
  document.body.append(dialog)
  return button
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('subagent settings navigation icon compatibility', () => {
  it.each(['子智能体', 'Subagents'])('replaces the fallback for the %s label', async (label) => {
    const button = settingsButton(label)
    const fallback = button.querySelector('[data-fallback]') as SVGSVGElement
    const dispose = installSubagentNavIcon(['子智能体', 'Subagents'])

    await settle()

    const host = button.querySelector(`[${SUBAGENT_NAV_ICON_MARKER}]`)
    const replacement = host?.querySelector('svg')
    expect(fallback.style.display).toBe('none')
    expect(replacement).not.toBeNull()
    expect(replacement?.getAttribute('class')).toBe('nav-icon')
    expect(replacement?.querySelector('path')).not.toBeNull()

    dispose()
    expect(fallback.style.display).toBe('')
    expect(button.querySelector(`[${SUBAGENT_NAV_ICON_MARKER}]`)).toBeNull()
  })

  it('ignores other rows and rows outside the settings dialog', async () => {
    const other = settingsButton('模型')
    const outside = document.createElement('button')
    outside.innerHTML = '<svg data-fallback="true"></svg><span>子智能体</span>'
    document.body.append(outside)
    const dispose = installSubagentNavIcon(['子智能体', 'Subagents'])

    await settle()

    expect(other.querySelector(`[${SUBAGENT_NAV_ICON_MARKER}]`)).toBeNull()
    expect(outside.querySelector(`[${SUBAGENT_NAV_ICON_MARKER}]`)).toBeNull()
    dispose()
  })

  it('repairs a row mounted after installation and restores it on label change', async () => {
    const dispose = installSubagentNavIcon(['子智能体', 'Subagents'])
    const button = settingsButton('子智能体')
    const fallback = button.querySelector('[data-fallback]') as SVGSVGElement

    await settle()
    expect(button.querySelector(`[${SUBAGENT_NAV_ICON_MARKER}]`)).not.toBeNull()
    expect(fallback.style.display).toBe('none')

    ;(button.querySelector('span:not([' + SUBAGENT_NAV_ICON_MARKER + '])') as HTMLSpanElement).textContent = '其他'
    await settle()
    expect(button.querySelector(`[${SUBAGENT_NAV_ICON_MARKER}]`)).toBeNull()
    expect(fallback.style.display).toBe('')
    dispose()
  })
})
