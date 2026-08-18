// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconGlobeOutline14: ({ size = 14, className }: { size?: number; className?: string }) => (
    <svg width={size} height={size} className={className} data-globe="true">
      <circle cx="7" cy="7" r="6" />
    </svg>
  ),
}))

import {
  installPluginCommunityNavIcon,
  PLUGIN_COMMUNITY_NAV_ICON_MARKER,
} from '../../src/plugin-market/client/nav-icon.tsx'

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

describe('plugin community settings navigation icon compatibility', () => {
  it.each(['插件社区', 'Plugin Community'])('replaces the fallback for the %s label', async (label) => {
    const button = settingsButton(label)
    const fallback = button.querySelector('[data-fallback]') as SVGSVGElement
    const dispose = installPluginCommunityNavIcon(['插件社区', 'Plugin Community'])

    await settle()

    const host = button.querySelector(`[${PLUGIN_COMMUNITY_NAV_ICON_MARKER}]`)
    const replacement = host?.querySelector('[data-globe]')
    expect(fallback.style.display).toBe('none')
    expect(replacement).not.toBeNull()
    expect(replacement?.getAttribute('width')).toBe('16')
    expect(replacement?.getAttribute('class')).toBe('nav-icon')

    dispose()
    expect(fallback.style.display).toBe('')
    expect(button.querySelector(`[${PLUGIN_COMMUNITY_NAV_ICON_MARKER}]`)).toBeNull()
  })

  it('ignores other rows and rows outside the settings dialog', async () => {
    const other = settingsButton('通用设置')
    const outside = document.createElement('button')
    outside.innerHTML = '<svg data-fallback="true"></svg><span>插件社区</span>'
    document.body.append(outside)
    const dispose = installPluginCommunityNavIcon(['插件社区', 'Plugin Community'])

    await settle()

    expect(other.querySelector(`[${PLUGIN_COMMUNITY_NAV_ICON_MARKER}]`)).toBeNull()
    expect(outside.querySelector(`[${PLUGIN_COMMUNITY_NAV_ICON_MARKER}]`)).toBeNull()
    dispose()
  })

  it('repairs a row mounted after installation and restores it on label change', async () => {
    const dispose = installPluginCommunityNavIcon(['插件社区', 'Plugin Community'])
    const button = settingsButton('插件社区')
    const fallback = button.querySelector('[data-fallback]') as SVGSVGElement

    await settle()
    expect(button.querySelector(`[${PLUGIN_COMMUNITY_NAV_ICON_MARKER}]`)).not.toBeNull()
    expect(fallback.style.display).toBe('none')

    const label = button.querySelector(`span:not([${PLUGIN_COMMUNITY_NAV_ICON_MARKER}])`) as HTMLSpanElement
    label.textContent = '其他'
    await settle()
    expect(button.querySelector(`[${PLUGIN_COMMUNITY_NAV_ICON_MARKER}]`)).toBeNull()
    expect(fallback.style.display).toBe('')
    dispose()
  })
})
