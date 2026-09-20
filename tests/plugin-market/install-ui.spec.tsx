// @vitest-environment jsdom
import type { Context } from '@deepseek-ai/cordis'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginMarket, type PluginMarketProps } from '../../src/plugin-market/client/PluginMarket.tsx'
import { MarketInstaller } from '../../src/plugin-market/client/installer.ts'
import { zh, type LocaleKey } from '../../src/plugin-market/client/locales.ts'

const t = ((key: LocaleKey) => zh[key]) as PluginMarketProps['t']
function setup(result = { changed: true, application: 'applied', stage: 'enable', target: 'example-plugin' } as object) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    plugins: [{ fullName: 'owner/plugin', packageName: 'example-plugin', description: 'Example',
      url: 'https://github.com/owner/plugin', ownerAvatarUrl: '', stars: 3, topics: [], installSpec: 'github:owner/plugin' }],
    fetchedAt: '2026-09-20T00:00:00Z', indexStale: false, page: 1, pageSize: 12, total: 1, totalPages: 1,
  }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  const manager = { installBundle: vi.fn(async () => ({ ok: true, value: result })),
    cancelInstall: vi.fn(async () => ({ ok: true, value: { status: 'cancelled' } })) }
  const installer = new MarketInstaller(manager as unknown as Context['remote']['pluginManager'])
  const openManager = vi.fn()
  const close = vi.fn()
  render(<PluginMarket t={t} installer={installer} openManager={openManager} close={close} />)
  return { fetchMock, manager, openManager, close }
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('community catalog delegates installation', () => {
  it('installs on the first click through DSH and leaves management to its native page', async () => {
    const { fetchMock, manager, openManager, close } = setup()
    fireEvent.click(await screen.findByRole('button', { name: zh.install }))
    await screen.findByText(zh.applied)
    expect(manager.installBundle).toHaveBeenCalledWith('github:owner/plugin', { requestId: expect.any(String) })
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes('/catalog?'))).toBe(true)
    expect(screen.queryByText('检查安装方式')).toBeNull()
    expect(screen.queryByText('卸载')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.manage }))
    expect(openManager).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('shows DSH pending builds without automatically approving them', async () => {
    const { manager } = setup({ changed: false, application: 'failed', stage: 'install', target: 'example-plugin',
      pendingBuilds: ['native-build'], error: { code: 'operation-error' } })
    fireEvent.click(await screen.findByRole('button', { name: zh.install }))
    await screen.findByText('native-build')
    expect(manager.installBundle).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: zh.approve }))
    await waitFor(() => expect(manager.installBundle).toHaveBeenCalledTimes(2))
    expect(manager.installBundle).toHaveBeenLastCalledWith('github:owner/plugin', {
      requestId: expect.any(String), approvedBuilds: ['native-build'],
    })
  })

  it.each([
    ['restart-required', 'enable', zh.restart],
    ['overridden', 'enable', zh.overridden],
    ['failed', 'enable', zh.enableFailed],
    ['cancelled', 'install', zh.cancelled],
  ])('reports the DSH %s result without claiming unconditional success', async (application, stage, message) => {
    setup({ changed: true, application, stage, target: 'example-plugin' })
    fireEvent.click(await screen.findByRole('button', { name: zh.install }))
    await screen.findByText(message)
    expect(screen.queryByText(zh.applied)).toBeNull()
  })
})
