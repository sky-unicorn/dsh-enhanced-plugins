import type { Context as ClientContext } from '@deepseek-ai/cordis'
import * as editLastMessage from '../edit-last-message/client/index.ts'
import * as mcpServerManager from '../mcp-server-manager/client/index.ts'
import * as modelInputTypes from '../model-input-types/client/index.ts'
import * as notification from '../notification/client/index.ts'
import * as pluginMarket from '../plugin-market/client/index.ts'
import * as subAgent from '../sub-agent/client/index.ts'
import * as agentTeamMonitor from '../agent-team-monitor/client/index.ts'

export const name = 'enhanced-plugins-client'
export const inject: string[] = []

/** Mount each browser capability as an independent child fiber. */
export function apply(ctx: ClientContext): void {
  ctx.plugin(editLastMessage)
  ctx.plugin(mcpServerManager)
  ctx.plugin(modelInputTypes)
  ctx.plugin(notification)
  ctx.plugin(pluginMarket)
  ctx.plugin(subAgent)
  ctx.plugin(agentTeamMonitor)
}
