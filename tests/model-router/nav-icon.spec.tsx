// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

import { installRouterNavIcon, ROUTER_NAV_ICON_MARKER } from '../../src/model-router/client/nav-icon.tsx'

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
  it.each(['多模型协作', 'Model collaboration'])('replaces the fallback for the %s label', async (label) => {
    const button = settingsButton(label)
    const fallback = button.querySelector('[data-fallback]') as SVGSVGElement
    const dispose = installRouterNavIcon(['多模型协作', 'Model collaboration'])

    await settle()

    const host = button.querySelector(`[${ROUTER_NAV_ICON_MARKER}]`)
    const replacement = host?.querySelector('svg')
    expect(fallback.style.display).toBe('none')
    expect(replacement).not.toBeNull()
    expect(replacement?.getAttribute('class')).toBe('nav-icon')
    expect(replacement?.querySelector('path')).not.toBeNull()

    dispose()
    expect(fallback.style.display).toBe('')
    expect(button.querySelector(`[${ROUTER_NAV_ICON_MARKER}]`)).toBeNull()
  })

  it('ignores other rows and rows outside the settings dialog', async () => {
    const other = settingsButton('模型')
    const outside = document.createElement('button')
    outside.innerHTML = '<svg data-fallback="true"></svg><span>多模型协作</span>'
    document.body.append(outside)
    const dispose = installRouterNavIcon(['多模型协作', 'Model collaboration'])

    await settle()

    expect(other.querySelector(`[${ROUTER_NAV_ICON_MARKER}]`)).toBeNull()
    expect(outside.querySelector(`[${ROUTER_NAV_ICON_MARKER}]`)).toBeNull()
    dispose()
  })

  it('repairs a row mounted after installation and restores it on label change', async () => {
    const dispose = installRouterNavIcon(['多模型协作', 'Model collaboration'])
    const button = settingsButton('多模型协作')
    const fallback = button.querySelector('[data-fallback]') as SVGSVGElement

    await settle()
    expect(button.querySelector(`[${ROUTER_NAV_ICON_MARKER}]`)).not.toBeNull()
    expect(fallback.style.display).toBe('none')

    ;(button.querySelector('span:not([' + ROUTER_NAV_ICON_MARKER + '])') as HTMLSpanElement).textContent = '其他'
    await settle()
    expect(button.querySelector(`[${ROUTER_NAV_ICON_MARKER}]`)).toBeNull()
    expect(fallback.style.display).toBe('')
    dispose()
  })
})
