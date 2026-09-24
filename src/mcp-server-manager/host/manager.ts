/**
 * The live-connection reconciler: turns the resolved `servers` record into a
 * set of `mcp-client` sub-plugins mounted under this plugin's context.
 *
 * Each record key is a `serverName` and each value is a stdio or Streamable
 * HTTP server definition; the reconciler starts, restarts, and disposes one
 * supervised `mcp-client` fiber per entry as the resolved settings section
 * changes, so the Web UI (or a hand-edited profile patch) can add and
 * remove MCP servers without touching the composition layer.
 *
 * Mounting is standard Cordis dynamic composition: `ctx.plugin(mcpClient,
 * config)` creates one independent fiber per call (the framework supports
 * multiple concurrent instances of the same plugin with different configs),
 * and `fiber.dispose()` unloads exactly that instance — running the
 * `mcp-client` effects that disconnect the server, unregister its tools, and
 * release the `serverName` reservation. There is no built-in per-context
 * child list, so this class tracks its own handles (the documented pattern).
 */

import type { Context } from '@deepseek-ai/cordis'
// The mcp-client plugin, imported as an object-form plugin (it exports
// `name`/`inject`/`Config`/`apply`): `ctx.plugin` accepts that shape.
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import { toMcpClientConfig, type Config, type ServerDefinition } from './schema.js'

/**
 * One mounted server's handle: the fiber `ctx.plugin` returned, with its
 * `dispose()` for teardown and the definition it was mounted from (for change
 * detection). The fiber is also thenable; awaiting it rethrows config/startup
 * errors, so a `.catch` is attached at mount time to keep one bad server
 * from surfacing as an unhandled rejection.
 */
interface MountedServer {
  /** Disposes this fiber: disconnects, unregisters tools, releases the name. */
  dispose(): Promise<void>
  /** The definition this mount was built from, for change detection. */
  def: ServerDefinition
}

/**
 * Owns the live fibers for the currently-configured server record. The
 * plugin reconcile path drives {@link reconcile}; disposal stops every server.
 */
export class McpServerManager {
  /** Live server fibers keyed by `serverName`. */
  private readonly handles = new Map<string, MountedServer>()
  /** Per-name transition chains; a replacement starts only after old disposal. */
  private readonly transitions = new Map<string, Promise<void>>()
  private desired = new Map<string, ServerDefinition>()
  private stopped = false

  /**
   * @param ctx - plugin context; each server mounts a child fiber through it.
   */
  constructor(private readonly ctx: Context) {}

  /**
   * Reconcile the live handles against the next server record: dispose
   * removed servers, start new ones, and restart servers whose definition
   * changed. Unchanged definitions are left alone, so unrelated settings
   * changes never reconnect a healthy server.
   * @param next - the currently authoritative config.
   */
  reconcile(next: Config): void {
    if (this.stopped) return
    this.desired = new Map(Object.entries(next.servers))
    const names = new Set([...this.desired.keys(), ...this.handles.keys(), ...this.transitions.keys()])
    for (const serverName of names) {
      const preceding = this.transitions.get(serverName) ?? Promise.resolve()
      const transition = preceding.then(() => this.syncServer(serverName)).catch(error => {
        this.ctx.logger.error(`mcp-manager: server "${serverName}" transition failed: ${String(error)}`)
      })
      this.transitions.set(serverName, transition)
      void transition.then(() => {
        if (this.transitions.get(serverName) === transition) this.transitions.delete(serverName)
      })
    }
  }

  /** Reconcile one namespace after its preceding disposal has settled. */
  private async syncServer(serverName: string): Promise<void> {
    if (this.stopped) return
    const previous = this.handles.get(serverName)
    const requested = this.desired.get(serverName)
    if (previous !== undefined && requested !== undefined && jsonEqual(previous.def, requested)) return
    if (previous !== undefined) {
      this.handles.delete(serverName)
      await previous.dispose()
    }
    if (this.stopped) return
    const latest = this.desired.get(serverName)
    if (latest === undefined) return
    try {
      const fiber = this.ctx.plugin(mcpClient, toMcpClientConfig(serverName, latest))
      // Connection startup remains asynchronous; only disposal is serialized.
      void Promise.resolve(fiber).catch(error => {
        this.ctx.logger.error(`mcp-manager: server "${serverName}" refused: ${String(error)}`)
      })
      this.handles.set(serverName, { dispose: () => fiber.dispose(), def: latest })
    } catch (error) {
      this.ctx.logger.error(`mcp-manager: server "${serverName}" refused: ${String(error)}`)
    }
  }

  /**
   * Dispose every live server and forget all tracked definitions.
   * @returns settlement after every handle has quiesced.
   */
  async dispose(): Promise<void> {
    this.stopped = true
    this.desired.clear()
    await Promise.allSettled([...this.transitions.values()])
    await Promise.allSettled([...this.handles.values()].map(handle => handle.dispose()))
    this.handles.clear()
    this.transitions.clear()
  }
}

/** Structural equality for change detection (config values are JSON-shaped). */
function jsonEqual(a: ServerDefinition, b: ServerDefinition): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
