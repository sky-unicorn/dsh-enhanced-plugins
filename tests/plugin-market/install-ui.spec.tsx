// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginMarket, type PluginMarketProps } from '../../src/plugin-market/client/PluginMarket.tsx'
import { zh, type LocaleKey } from '../../src/plugin-market/client/locales.ts'

const t = ((key: LocaleKey) => zh[key]) as PluginMarketProps['t']

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}

function plugin(fullName: string, packageName: string) {
  return {
    fullName,
    packageName,
    description: `${packageName} description`,
    url: `https://github.com/${fullName}`,
    ownerAvatarUrl: 'https://github.com/example.png',
    stars: 10,
    updatedAt: '2026-08-25T00:00:00.000Z',
    topics: ['dsh-plugin'],
    installed: false,
    removable: false,
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('capability-aware install actions', () => {
  it('reveals one-click install only after npm verification and sends manual plugins to their instructions', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/catalog?')) {
        return json({
          plugins: [plugin('owner/npm-plugin', 'npm-plugin'), plugin('owner/manual-plugin', 'manual-plugin')],
          fetchedAt: '2026-08-25T00:00:00.000Z',
          indexStale: false,
          rateLimitRemaining: null,
          profile: 'web',
          page: 1,
          pageSize: 12,
          total: 2,
          totalPages: 1,
        })
      }
      if (url.endsWith('/install-plan')) {
        const request = JSON.parse(String(init?.body)) as { readonly fullName: string }
        const plan = request.fullName === 'owner/npm-plugin'
          ? {
            kind: 'npm',
            packageName: 'npm-plugin',
            version: '1.2.3',
            repository: 'owner/npm-plugin',
          }
          : {
            kind: 'manual',
            packageName: 'manual-plugin',
            repository: 'owner/manual-plugin',
            documentationUrl: 'https://github.com/owner/manual-plugin#readme',
            reason: 'requires-build-approval',
          }
        return json({
          id: 'plan-job',
          fullName: request.fullName,
          createdAt: '2026-08-25T00:00:00.000Z',
          completedAt: '2026-08-25T00:00:01.000Z',
          state: 'completed',
          plan,
        })
      }
      throw new Error(`unexpected fetch ${url}`)
    }))

    render(<PluginMarket t={t} />)
    const npmCard = (await screen.findByText('owner/npm-plugin')).closest('li')
    const manualCard = screen.getByText('owner/manual-plugin').closest('li')
    if (npmCard === null || manualCard === null) throw new Error('plugin card missing')

    expect(within(npmCard).getByRole('button', { name: '检查安装方式' })).toBeTruthy()
    expect(within(npmCard).queryByRole('button', { name: '一键安装' })).toBeNull()
    fireEvent.click(within(npmCard).getByRole('button', { name: '检查安装方式' }))
    await waitFor(() => expect(within(npmCard).getByRole('button', { name: '一键安装' })).toBeTruthy())
    expect(within(npmCard).getByText('已验证 npm 1.2.3，可直接安装。')).toBeTruthy()

    fireEvent.click(within(manualCard).getByRole('button', { name: '检查安装方式' }))
    const instructions = await within(manualCard).findByRole('link', { name: '查看安装说明' })
    expect(instructions.getAttribute('href')).toBe('https://github.com/owner/manual-plugin#readme')
    expect(within(manualCard).queryByRole('button', { name: '一键安装' })).toBeNull()
  })

  it('shows externally managed dependencies as installed without offering removal', async () => {
    const installed = {
      ...plugin('sky-unicorn/dsh-enhanced-plugins', 'dsh-enhanced-plugins'),
      installed: true,
      removable: false,
      installedSpec: 'file:../../../../dsh-enhanced-plugins',
    }
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/catalog?')) {
        return json({
          plugins: [installed],
          fetchedAt: '2026-08-25T00:00:00.000Z',
          indexStale: false,
          rateLimitRemaining: null,
          profile: 'web',
          page: 1,
          pageSize: 12,
          total: 1,
          totalPages: 1,
        })
      }
      throw new Error(`unexpected fetch ${url}`)
    }))

    render(<PluginMarket t={t} />)
    const card = (await screen.findByText('sky-unicorn/dsh-enhanced-plugins')).closest('li')
    if (card === null) throw new Error('plugin card missing')
    const installedButton = within(card).getByRole('button', { name: '已安装' })
    expect(installedButton.hasAttribute('disabled')).toBe(true)
    expect(within(card).queryByRole('button', { name: '卸载' })).toBeNull()
    expect(within(card).getByText('此项由当前 profile 或外部安装流程管理，不能从插件社区卸载。')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: '已安装' }))
    await waitFor(() => expect(screen.getByText('sky-unicorn/dsh-enhanced-plugins')).toBeTruthy())
  })

  it('shows the generation time and warns when the automated index is stale', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/catalog?')) {
        return json({
          plugins: [],
          fetchedAt: '2026-08-20T00:00:00.000Z',
          indexStale: true,
          rateLimitRemaining: null,
          profile: 'web',
          page: 1,
          pageSize: 12,
          total: 0,
          totalPages: 1,
        })
      }
      throw new Error(`unexpected fetch ${url}`)
    }))

    render(<PluginMarket t={t} />)

    expect(await screen.findByText('索引生成时间')).toBeTruthy()
    expect(screen.getByText('安装目标').closest('dl')).toBe(screen.getByText('索引生成时间').closest('dl'))
    expect(screen.getByRole('heading', { name: '插件社区' }).closest('header')
      ?.contains(screen.getByRole('button', { name: '同步最新索引' }))).toBe(true)
    expect(screen.getByText(zh.indexStale)).toBeTruthy()
    expect(screen.getByRole('button', { name: '同步最新索引' })).toBeTruthy()
  })
})
