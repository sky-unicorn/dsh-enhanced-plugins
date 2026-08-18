import type { Context, Fiber } from '@deepseek-ai/cordis'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import type {} from '@deepseek-ai/dsh-settings'
import { SETTINGS_NAMESPACE } from './settings.js'
import type { ProductToggleSettings } from './shared.js'

export const name = 'subagent-product-toggle-preset'
export const inject = ['tools', 'subagents', 'systemPrompt', 'settings']

type Product = 'claudeCode' | 'codex'

const PRODUCTS: Record<Product, ToolSubagent.Config> = {
  claudeCode: {
    provider: 'claude-code',
    toolName: 'subagent_claude_code',
    enableRunInBackground: false,
    maxDepth: 'provider-managed',
  },
  codex: {
    provider: 'codex',
    toolName: 'subagent_codex',
    enableRunInBackground: false,
    maxDepth: 'provider-managed',
  },
}

export function apply(ctx: Context): void {
  const mounted = new Map<Product, Fiber>()
  let queue = Promise.resolve()

  const reconcile = async (): Promise<void> => {
    const value = ctx.settings.get(SETTINGS_NAMESPACE) as ProductToggleSettings | undefined
    if (value === undefined) throw new Error(`missing settings namespace ${SETTINGS_NAMESPACE}`)
    for (const product of Object.keys(PRODUCTS) as Product[]) {
      const current = mounted.get(product)
      if (value[product] && current === undefined) {
        mounted.set(product, await ctx.plugin(ToolSubagent, PRODUCTS[product]))
      } else if (!value[product] && current !== undefined) {
        await current.dispose()
        mounted.delete(product)
      }
    }
  }

  const schedule = (): void => {
    queue = queue.then(reconcile, reconcile).catch(error => ctx.logger.error(error))
  }

  ctx.on('settings/updated', (namespace) => {
    if (namespace === SETTINGS_NAMESPACE) schedule()
  })
  ctx.effect(() => {
    schedule()
    return async () => {
      await queue
      await Promise.all([...mounted.values()].map(fiber => fiber.dispose()))
      mounted.clear()
    }
  }, 'subagent-product-toggle-preset: managed tool consumers')
}
