import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { MarketInstaller } from '../../src/plugin-market/client/installer.ts'

const success = { ok: true, value: { changed: true, application: 'applied', stage: 'enable', target: 'example-plugin' } }
function fixture() {
  const manager = { installBundle: vi.fn(async () => success),
    cancelInstall: vi.fn(async () => ({ ok: true, value: { status: 'cancelled' } })), inspect: vi.fn() }
  const installer = new MarketInstaller(manager as unknown as Context['remote']['pluginManager'])
  return { manager, installer }
}

describe('DSH installation delegation', () => {
  it('passes the source directly to DSH without an inspect preflight or implicit build approval', async () => {
    const { manager, installer } = fixture()
    await installer.install('github:owner/plugin')
    expect(manager.installBundle).toHaveBeenCalledWith('github:owner/plugin', { requestId: expect.any(String) })
    expect(manager.inspect).not.toHaveBeenCalled()
    expect(installer.getSnapshot()).toMatchObject({ pending: false, result: success.value })
  })

  it('approves only the exact pending names returned by DSH, on an explicit retry', async () => {
    const { manager, installer } = fixture()
    manager.installBundle.mockResolvedValueOnce({ ok: true, value: {
      changed: false, application: 'failed', stage: 'install', target: 'github:owner/plugin',
      pendingBuilds: ['build-dependency'],
    } } as typeof success)
    await installer.install('github:owner/plugin')
    expect(manager.installBundle).toHaveBeenCalledTimes(1)
    await installer.approveAndRetry()
    expect(manager.installBundle).toHaveBeenLastCalledWith('github:owner/plugin', {
      requestId: expect.any(String), approvedBuilds: ['build-dependency'],
    })
  })

  it('keeps a disconnected operation pending and prevents duplicate installs until DSH acknowledges cancellation', async () => {
    const { manager, installer } = fixture()
    manager.installBundle.mockRejectedValueOnce(new Error('connection lost'))
    await installer.install('github:owner/plugin')
    expect(installer.getSnapshot()).toMatchObject({ pending: true, error: 'connection lost' })
    await installer.install('github:owner/other')
    expect(manager.installBundle).toHaveBeenCalledTimes(1)
    await installer.cancel()
    expect(manager.cancelInstall).toHaveBeenCalledWith(manager.installBundle.mock.calls[0]?.[1]?.requestId)
    expect(installer.getSnapshot()).toMatchObject({ pending: false, result: { application: 'cancelled' } })
  })

  it('ignores a late result after an acknowledged cancellation and a newer install', async () => {
    const { manager, installer } = fixture()
    let finish!: (value: typeof success) => void
    manager.installBundle.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const old = installer.install('github:owner/old')
    await installer.cancel()
    await installer.install('github:owner/new')
    finish(success)
    await old
    expect(installer.getSnapshot()).toMatchObject({ spec: 'github:owner/new', pending: false })
  })

  it('asks DSH to cancel on fiber disposal and never notifies disposed subscribers', async () => {
    const { manager, installer } = fixture()
    let finish!: (value: typeof success) => void
    manager.installBundle.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const listener = vi.fn()
    installer.subscribe(listener)
    const installing = installer.install('github:owner/plugin')
    await installer.dispose()
    listener.mockClear()
    finish(success)
    await installing
    expect(manager.cancelInstall).toHaveBeenCalledOnce()
    expect(listener).not.toHaveBeenCalled()
  })
})
