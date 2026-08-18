import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { SETTINGS_NAMESPACE } from './settings.js'
import type { ProductToggleSettings } from './shared.js'

export const name = 'subagent-product-toggles'
export const inject: string[] = []

export const Config: z<ProductToggleSettings> = z.object({
  claudeCode: z.boolean().default(false).description('Expose Claude Code to agents.'),
  codex: z.boolean().default(false).description('Expose Codex to agents.'),
})

// tsdown intentionally preserves stage-3 decorator syntax, which Node 22 cannot
// parse. Apply the same Remote decorator protocol explicitly at construction.
function exposeRemote<This extends object, Args extends unknown[], Result>(
  service: This,
  name: string,
  method: (this: This, ...args: Args) => Result,
): void {
  Remote(name)(method, {
    name,
    static: false,
    private: false,
    addInitializer(initializer: (this: This) => void): void { initializer.call(service) },
  } as unknown as ClassMethodDecoratorContext<This, typeof method>)
}

class SubagentProductsRemote extends TypertRemoteService {
  static inject = ['settings']

  constructor(ctx: Context) {
    super(ctx, 'subagentProducts')
    exposeRemote(this, 'describe', this.describe)
    exposeRemote(this, 'set', this.set)
  }

  private descriptor(): { value: ProductToggleSettings; revision: number } | undefined {
    const found = this.ctx.settings.describe({ redactSecrets: true }).find(entry => entry.ns === SETTINGS_NAMESPACE)
    return found === undefined ? undefined : { value: found.value as ProductToggleSettings, revision: found.revision }
  }

  describe(): { registered: boolean; writable: boolean; value?: ProductToggleSettings; revision?: number } {
    const current = this.descriptor()
    return current === undefined
      ? { registered: false, writable: false }
      : { registered: true, writable: this.ctx.settings.writable, value: current.value, revision: current.revision }
  }

  async set(request: unknown): Promise<{ kind: 'ok' | 'conflict'; revision: number }> {
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      throw new TypeError('subagentProducts/set: request must be an object')
    }
    const candidate = request as { product?: unknown; enabled?: unknown; expectedRevision?: unknown }
    if ((candidate.product !== 'claudeCode' && candidate.product !== 'codex') || typeof candidate.enabled !== 'boolean') {
      throw new TypeError('subagentProducts/set: invalid product or enabled value')
    }
    if (candidate.expectedRevision !== undefined
      && (!Number.isSafeInteger(candidate.expectedRevision) || (candidate.expectedRevision as number) < 0)) {
      throw new TypeError('subagentProducts/set: expectedRevision must be a non-negative safe integer')
    }
    const product = candidate.product
    const expectedRevision = candidate.expectedRevision as number | undefined
    try {
      await this.ctx.settings.mutate(
        SETTINGS_NAMESPACE,
        [{ op: 'set', path: [product], value: candidate.enabled }],
        expectedRevision,
      )
    } catch (error) {
      if (error instanceof SettingsConflictError) return { kind: 'conflict', revision: error.actual }
      throw error
    }
    return { kind: 'ok', revision: this.descriptor()?.revision ?? 0 }
  }
}

export function apply(ctx: Context, config: ProductToggleSettings): void {
  ctx.inject(['settings'], (scope) => {
    scope.settings.register(SETTINGS_NAMESPACE, Config, { base: config })
    new SubagentProductsRemote(scope)
  })
}
