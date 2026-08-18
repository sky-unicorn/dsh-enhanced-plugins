/**
 * The live-connection reconciler: turns the resolved `servers` record into a
 * set of `mcp-client` sub-plugins mounted under this plugin's context.
 *
 * Each record key is a `serverName` and each value is a stdio or Streamable
 * HTTP server definition; the reconciler starts, restarts, and disposes one
 * supervised `mcp-client` fiber per entry as the resolved settings section
 * changes, so the Web UI (or a hand-edited `settings.yaml`) can add and
 * remove MCP servers without touching `cordis.yml`.
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
    const { logger } = this.ctx

    // Remove servers no longer present.
    for (const [serverName, handle] of [...this.handles.entries()]) {
      if (Object.hasOwn(next.servers, serverName)) continue
      void handle.dispose()
      this.handles.delete(serverName)
    }

    // Start new servers and restart changed ones.
    for (const [serverName, def] of Object.entries(next.servers)) {
      const previous = this.handles.get(serverName)
      if (previous !== undefined && jsonEqual(previous.def, def)) continue
      if (previous !== undefined) {
        void previous.dispose()
        this.handles.delete(serverName)
      }
      try {
        const fiber = this.ctx.plugin(mcpClient, toMcpClientConfig(serverName, def))
        // Do not await: a slow initial connection must not block the
        // reconcile loop or the settings change that triggered it. Attach a
        // catch so a failed startup (with `failOnStartupError: false` this is
        // already contained, but a config error would reject) is logged
        // rather than surfacing as an unhandled rejection.
        void Promise.resolve(fiber).catch(error => {
          logger.error(`mcp-manager: server "${serverName}" refused: ${String(error)}`)
        })
        this.handles.set(serverName, {
          dispose: () => fiber.dispose(),
          def,
        })
      } catch (error) {
        // A synchronous throw (e.g. duplicate `serverName` reservation) is
        // logged here; the entry is left unset so a later reconcile retries.
        logger.error(`mcp-manager: server "${serverName}" refused: ${String(error)}`)
      }
    }
  }

  /**
   * Dispose every live server and forget all tracked definitions.
   * @returns settlement after every handle has quiesced.
   */
  async dispose(): Promise<void> {
    await Promise.allSettled([...this.handles.values()].map(handle => handle.dispose()))
    this.handles.clear()
  }
}

/** Structural equality for change detection (config values are JSON-shaped). */
function jsonEqual(a: ServerDefinition, b: ServerDefinition): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
