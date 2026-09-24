import { Service, type Context } from '@deepseek-ai/cordis'
import { SettingsConflictError, type SettingsNamespace } from '@deepseek-ai/dsh-settings'

type SchemaLike = (value?: unknown) => unknown
type Operation = { op: 'set' | 'unset'; path: readonly string[]; value?: unknown }
type Section = { ns: SettingsNamespace; schema: SchemaLike; base: Record<string, unknown>; user: Record<string, unknown>; value: Record<string, unknown>; revision: number }

function plain(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof (value as { get?: unknown }).get === 'function') return plain((value as { get: () => unknown }).get())
  if (Array.isArray(value)) return value.map(plain)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plain(child)]))
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function mergeLayers(base: unknown, user: unknown): unknown {
  if (!isRecord(base) || !isRecord(user)) return user
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(user)) result[key] = key in result ? mergeLayers(result[key], value) : value
  return result
}

function applyOps(input: Record<string, unknown>, ops: readonly Operation[]): Record<string, unknown> {
  const result = structuredClone(input)
  for (const op of ops) {
    if (op.path.length === 0) throw new Error('MemorySettings requires a field path')
    let parent: Record<string, unknown> = result
    let found = true
    for (const key of op.path.slice(0, -1)) {
      if (!isRecord(parent[key])) {
        if (op.op === 'unset') { found = false; break }
        parent[key] = {}
      }
      parent = parent[key] as Record<string, unknown>
    }
    if (!found) continue
    const field = op.path.at(-1)!
    if (op.op === 'set') parent[field] = structuredClone(op.value)
    else delete parent[field]
  }
  return result
}

/** Small in-memory implementation of the DSH 0.1.7 settings form seam. */
export class MemorySettings extends Service {
  static inject: string[] = []
  readonly persisted: Array<{ ns: SettingsNamespace; section: Record<string, unknown> }> = []
  private readonly storedDocument: Record<string, unknown>
  private readonly sections = new Map<SettingsNamespace, Section>()

  constructor(ctx: Context, options?: { document?: Record<string, unknown> }) {
    super(ctx, 'settings')
    this.storedDocument = structuredClone(options?.document ?? {})
  }

  get writable(): boolean { return true }
  configure(_presentation: { auto?: boolean }): () => void { return () => {} }

  register(ns: SettingsNamespace, schema: SchemaLike, options: { base?: Record<string, unknown> } = {}): void {
    const base = structuredClone(options.base ?? {})
    const user = structuredClone((this.storedDocument[String(ns)] as Record<string, unknown> | undefined) ?? {})
    const value = plain(schema(mergeLayers(base, user))) as Record<string, unknown>
    this.sections.set(ns, { ns, schema, base, user, value, revision: 0 })
  }

  get(ns: SettingsNamespace): Record<string, unknown> | undefined { return this.sections.get(ns)?.value }

  describe(): Array<Record<string, unknown>> {
    return [...this.sections.values()].map(section => ({ ns: section.ns, autoGenerate: false, schema: section.schema,
      value: structuredClone(section.value), base: structuredClone(section.base), user: structuredClone(section.user),
      revision: section.revision, applies: 'live', }))
  }

  async mutate(ns: SettingsNamespace, ops: readonly Operation[], expectedRevision?: number): Promise<void> {
    const section = this.sections.get(ns)
    if (!section) throw new Error(`missing settings namespace ${String(ns)}`)
    if (expectedRevision !== undefined && expectedRevision !== section.revision) throw new SettingsConflictError(ns, expectedRevision, section.revision)
    section.user = applyOps(section.user, ops)
    section.value = plain(section.schema(mergeLayers(section.base, section.user))) as Record<string, unknown>
    section.revision += 1
    this.storedDocument[String(ns)] = structuredClone(section.user)
    this.persisted.push({ ns, section: structuredClone(section.user) })
    this.ctx.emit('settings/document-updated', ns, section.revision)
  }
}
