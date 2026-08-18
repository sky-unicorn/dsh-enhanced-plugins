/**
 * Minimal stub of the mcp-client plugin namespace. manager.ts imports it as
 * `* as mcpClient` and passes it to `ctx.plugin`; the manager's own reconcile
 * tests substitute a fake mount callback, so only the plugin-shaped surface
 * is needed here.
 */

export const name = 'mcp-client'
export const inject = ['tools']
export const Config = {}
export const apply = (): void => {}
