/**
 * The MCP card's staged form over the `mcp` namespace, served through the
 * `mcpConfig` Remote store.
 *
 * This card stages a detached server record. Existing servers are edited with
 * field ops applied to the Host's unmasked definition, so unchanged secrets
 * never cross the wire or get replaced with their display mask.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  McpConfigSnapshot, McpFormatReport, McpImportSource, McpImportSummary,
  McpServerFieldOp, McpWireOp,
} from './mcp-config-store.ts'

const SECRET_MASK = '••••'
const DEFAULT_TIMEOUT_MS = 60_000

/** The `mcpConfig` store surface this controller reads and writes through. */
export interface McpConfigSource {
  /** The current masked namespace snapshot. */
  getSnapshot(): McpConfigSnapshot
  /** Subscribe to snapshot changes. */
  subscribe(listener: () => void): () => void
  /** Apply one batch of path edits under revision fencing. */
  mutate(ops: readonly McpWireOp[], expectedRevision: number | undefined): Promise<boolean>
  /** Import external configs entirely on the Host, returning only a safe summary. */
  importServers(
    sources: readonly McpImportSource[],
    expectedRevision: number | undefined,
  ): Promise<McpImportSummary | undefined>
}

/** Form state the card shell renders (the shared card chrome contract). */
export interface CardShell {
  /** False while the namespace is not served to this client; the card renders nothing. */
  available: boolean
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** Whether the form holds edits that a save would write. */
  dirty: boolean
  /** Whether any staged draft is invalid, which blocks the save. */
  invalid: boolean
  /** Whether a save is crossing the wire. */
  saving: boolean
  /** Whether the last save did not land as staged; cleared by the next edit or save. */
  failed: boolean
}

/**
 * Namespace of the MCP manager. Spelled here rather than imported: a client
 * package must not depend on a Host package.
 */
export const MCP_NS = 'mcp-manager'

/** The `serverName` contract, kept in sync with the manager's key pattern. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** One stdio server's editable fields (all optional in the wire section). */
export interface StdioMcpServer {
  transport: 'stdio'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  toolCallTimeoutMs?: number
}

/** One Streamable HTTP server's editable fields. */
export interface StreamableHttpMcpServer {
  transport: 'streamable-http'
  url?: string
  headers?: Record<string, string>
  toolCallTimeoutMs?: number
}

/** One server definition inside the `mcp` section. */
export type McpServer = StdioMcpServer | StreamableHttpMcpServer

/** The `mcp` namespace section shape this card edits. */
export interface McpSettings {
  servers?: Record<string, McpServer>
}

/** One server row the card renders. */
export interface McpServerRow {
  /** The record key, also the model-facing namespace. */
  serverName: string
  /** Which transport the server uses. */
  transport: 'stdio' | 'streamable-http'
  /** The command or URL, shown as the row's target. */
  target: string
  /** Format status from the Host audit (or local validation for a staged addition). */
  format: 'valid' | 'warning' | 'error'
}

/** One key-value row in the server form's `env`/`headers` lists. */
export interface DraftPair {
  /** The variable or header name. */
  key: string
  /** The variable or header value. */
  value: string
}

/** The server form's draft fields: text fields as strings, list fields as rows. */
export interface McpDraftForm {
  serverName: string
  transport: 'stdio' | 'streamable-http'
  command: string
  url: string
  /** One whole argument per row, in order. */
  args: string[]
  cwd: string
  /** Environment variable rows; blank rows drop on commit. */
  env: DraftPair[]
  /** Header rows; blank rows drop on commit. */
  headers: DraftPair[]
  toolCallTimeoutMs: string
}

/** Form fields staged as a single text value. */
export type McpTextField = 'serverName' | 'transport' | 'command' | 'url' | 'cwd' | 'toolCallTimeoutMs'

/** Add-form fields staged as editable row lists. */
export type McpListField = 'args' | 'env' | 'headers'

/** What the MCP card renders. */
export interface McpCardState extends CardShell {
  /** The servers the card currently shows (draft when dirty, else the document). */
  servers: McpServerRow[]
  /** The server form, present while open. */
  form: McpDraftForm | null
  /** Name of the row being edited, or null for an add form. */
  editingName: string | null
  /** True when a staged serverName already exists, or the form is otherwise invalid. */
  formInvalid: boolean
  /** Value-free Host audit of the currently persisted record. */
  format: McpFormatReport
  /** Whether Host-side external discovery/import is running. */
  importing: boolean
  /** Safe summary of the last import action. */
  importResult: McpImportSummary | null
}

/** The registration-side face the MCP card's slot entry injects. */
export interface McpCardFace {
  hooks: {
    /** Card snapshot bound by the renderer as useMcpCard. */
    mcpCard: SnapshotStore<McpCardState>
  }
  /** Write every staged edit. */
  save: () => void
  /** Drop every staged edit. */
  discard: () => void
  /** Open the add form. */
  openForm: () => void
  /** Open an existing server in the form. */
  editServer: (serverName: string) => void
  /** Close the add form and drop its draft. */
  closeForm: () => void
  /** Stage one single-line form field. */
  editForm: (field: McpTextField, text: string) => void
  /** Stage one row of a list field: `args` rows take the value, `env`/`headers` rows the key or value. */
  editListRow: (field: McpListField, index: number, part: 'value' | 'key', text: string) => void
  /** Append one blank row to a list field. */
  appendListRow: (field: McpListField) => void
  /** Remove one row from a list field. */
  removeListRow: (field: McpListField, index: number) => void
  /** Commit the add or edit form into the staged record. */
  addServer: () => void
  /** Stage the removal of one server. */
  removeServer: (serverName: string) => void
  /** Import both Claude Code and Codex configs on the Host. */
  importServers: () => void
}

/** The initial add form: one argument row ready, env/headers appended on demand. */
function emptyForm(): McpDraftForm {
  return {
    serverName: '',
    transport: 'stdio',
    command: '',
    url: '',
    args: [''],
    cwd: '',
    env: [],
    headers: [],
    toolCallTimeoutMs: String(DEFAULT_TIMEOUT_MS),
  }
}

/** Seed an edit form from a masked server without revealing its credentials. */
function formFor(serverName: string, server: McpServer): McpDraftForm {
  return {
    serverName,
    transport: server.transport,
    command: server.transport === 'stdio' ? server.command ?? '' : '',
    url: server.transport === 'streamable-http' ? server.url ?? '' : '',
    args: server.transport === 'stdio' ? [...(server.args ?? [])] : [],
    cwd: server.transport === 'stdio' ? server.cwd ?? '' : '',
    env: server.transport === 'stdio'
      ? Object.entries(server.env ?? {}).map(([key, value]) => ({ key, value })) : [],
    headers: server.transport === 'streamable-http'
      ? Object.entries(server.headers ?? {}).map(([key, value]) => ({ key, value })) : [],
    toolCallTimeoutMs: String(server.toolCallTimeoutMs ?? DEFAULT_TIMEOUT_MS),
  }
}

/**
 * Collect argument rows for commit: each row holds one whole argument, trimmed;
 * blank rows drop.
 * @param rows - the staged argument rows.
 * @returns the committed argument list.
 */
export function collectArgs(rows: readonly string[]): string[] {
  return rows.map(row => row.trim()).filter(row => row !== '')
}

/**
 * Collect key-value rows for commit, dropping fully blank rows; a later row
 * with a repeated key overwrites the earlier one. Existing values retain
 * their exact text when `preserveText` is true.
 * @param rows - the staged key-value rows.
 * @param preserveText - keep existing keys and values verbatim during edits.
 * @returns the committed record, or undefined when a row has a value but no key.
 */
export function collectPairs(rows: readonly DraftPair[], preserveText = false): Record<string, string> | undefined {
  const entries: Array<[string, string]> = []
  for (const row of rows) {
    const key = preserveText ? row.key : row.key.trim()
    const value = preserveText ? row.value : row.value.trim()
    if (key === '' && value === '') continue
    if (key.trim() === '') return undefined
    entries.push([key, value])
  }
  return Object.fromEntries(entries)
}

/** Build the server definition the form describes, preserving existing text when editing. */
function parseForm(form: McpDraftForm, editing: boolean): McpServer | undefined {
  if (!SERVER_NAME_PATTERN.test(form.serverName)) return undefined
  const timeout = Number(form.toolCallTimeoutMs)
  if (!Number.isSafeInteger(timeout) || timeout < 1) return undefined
  const timeoutField = editing || timeout !== DEFAULT_TIMEOUT_MS ? { toolCallTimeoutMs: timeout } : {}
  if (form.transport === 'stdio') {
    if (form.command.trim() === '') return undefined
    const env = collectPairs(form.env, editing)
    if (env === undefined) return undefined
    const args = editing ? [...form.args] : collectArgs(form.args)
    return {
      transport: 'stdio',
      command: editing ? form.command : form.command.trim(),
      ...editing || args.length > 0 ? { args } : {},
      ...editing || Object.keys(env).length > 0 ? { env } : {},
      ...editing || form.cwd.trim() !== '' ? { cwd: editing ? form.cwd : form.cwd.trim() } : {},
      ...timeoutField,
    }
  }
  if (form.transport !== 'streamable-http') return undefined
  if (!isValidHttpUrl(form.url.trim())) return undefined
  const headers = collectPairs(form.headers, editing)
  if (headers === undefined || Object.keys(headers).some(key => !HEADER_NAME_PATTERN.test(key))) return undefined
  return {
    transport: 'streamable-http',
    url: editing ? form.url : form.url.trim(),
    ...editing || Object.keys(headers).length > 0 ? { headers } : {},
    ...timeoutField,
  }
}

const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** Whether text is an HTTP(S) endpoint without embedded credentials. */
export function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

/**
 * Whether the two JSON-shaped server records are structurally equal.
 * @param a - one server record.
 * @param b - the other server record.
 * @returns whether both records have the same keys with equal values.
 */
export function recordsEqual(a: Record<string, McpServer>, b: Record<string, McpServer>): boolean {
  const left = Object.keys(a)
  const right = Object.keys(b)
  if (left.length !== right.length) return false
  return left.every(key => key in b && JSON.stringify(a[key]) === JSON.stringify(b[key]))
}

/**
 * Plan one server op per changed entry. Edits carry only changed fields;
 * the Host applies them to its unmasked resolved record before persisting.
 * @param authoritative - the masked record the draft was staged over.
 * @param draft - the staged record.
 * @param origins - original names for staged rows, including renamed ones.
 * @returns the ordered ops for `mcpConfig/mutate`.
 */
export function planOps(
  authoritative: Record<string, McpServer>,
  draft: Record<string, McpServer>,
  origins?: ReadonlyMap<string, string>,
): McpWireOp[] {
  const ops: McpWireOp[] = []
  const retained = new Set<string>()
  for (const [serverName, server] of Object.entries(draft)) {
    const originalName = origins === undefined
      ? (Object.hasOwn(authoritative, serverName) ? serverName : undefined)
      : origins.get(serverName)
    const previous = originalName === undefined ? undefined : authoritative[originalName]
    if (previous === undefined || originalName === undefined) {
      ops.push({ op: 'set', path: ['servers', serverName], value: server })
      continue
    }
    retained.add(originalName)
    const changes = planFieldChanges(previous, server)
    if (originalName !== serverName || changes.length > 0 || previous.transport !== server.transport) {
      ops.push({
        op: 'edit', path: ['servers', originalName], nextName: serverName,
        changes: previous.transport === server.transport ? changes : [],
        ...previous.transport === server.transport ? {} : { replacement: server },
      })
    }
  }
  for (const serverName of Object.keys(authoritative)) {
    if (!retained.has(serverName)) ops.push({ op: 'unset', path: ['servers', serverName] })
  }
  return ops
}

/** Compare a masked server with its staged version without restating hidden values. */
function planFieldChanges(previous: McpServer, next: McpServer): McpServerFieldOp[] {
  if (previous.transport !== next.transport) return []
  const changes: McpServerFieldOp[] = []
  const scalarFields = previous.transport === 'stdio'
    ? ['command', 'args', 'cwd', 'toolCallTimeoutMs'] as const
    : ['url', 'toolCallTimeoutMs'] as const
  const beforeFields = previous as unknown as Record<string, unknown>
  const afterFields = next as unknown as Record<string, unknown>
  for (const field of scalarFields) {
    const before = beforeFields[field]
    const after = afterFields[field]
    if (JSON.stringify(before) === JSON.stringify(after)) continue
    if (after === undefined) changes.push({ op: 'unset', path: [field] })
    else changes.push({ op: 'set', path: [field], value: after })
  }
  const mapField = previous.transport === 'stdio' ? 'env' : 'headers'
  const beforeMap = (beforeFields[mapField] ?? {}) as Record<string, string>
  const afterMap = (afterFields[mapField] ?? {}) as Record<string, string>
  for (const key of Object.keys(beforeMap)) {
    if (!Object.hasOwn(afterMap, key)) changes.push({ op: 'unset', path: [mapField, key] })
  }
  for (const [key, value] of Object.entries(afterMap)) {
    if (Object.hasOwn(beforeMap, key) && value === SECRET_MASK) continue
    if (beforeMap[key] !== value) changes.push({ op: 'set', path: [mapField, key], value })
  }
  return changes
}

/** Bridges the `mcpConfig` store onto the MCP card's staged server record. */
export class McpCardController {
  private readonly store: SnapshotStore<McpCardState>
  /** Detached staged record; null while not dirty. */
  private draft: Record<string, McpServer> | null = null
  /** The authoritative row each draft row came from; additions have no entry. */
  private draftOrigins = new Map<string, string>()
  /** The exact read that owns this draft's edits and revision fence. */
  private draftBase: Record<string, McpServer> = {}
  private draftRevision: number | undefined
  /** The add form; null while closed. */
  private form: McpDraftForm | null = null
  private editingName: string | null = null
  /** Authoritative view and revision at form opening, before any remote refresh. */
  private formBase: Record<string, McpServer> | null = null
  private formRevision: number | undefined
  private saving = false
  private failed = false
  private importing = false
  private importResult: McpImportSummary | null = null

  /** @param config - the `mcpConfig` Remote store for the `mcp` namespace. */
  constructor(private readonly config: McpConfigSource) {
    this.store = createSnapshotStore(this.projection())
    config.subscribe(() => { this.publish() })
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its list-editing actions.
   */
  inject(): McpCardFace {
    return {
      hooks: { mcpCard: this.store },
      save: () => { void this.save() },
      discard: () => { this.discard() },
      openForm: () => {
        if (this.form !== null || this.saving || this.importing || !this.snapshot().writable) return
        this.captureFormBase()
        this.form = emptyForm()
        this.editingName = null
        this.publish()
      },
      editServer: (serverName) => { this.openEditForm(serverName) },
      closeForm: () => { this.closeForm(); this.publish() },
      editForm: (field, text) => { this.setForm(field, text) },
      editListRow: (field, index, part, text) => { this.editRow(field, index, part, text) },
      appendListRow: (field) => { this.appendRow(field) },
      removeListRow: (field, index) => { this.removeRow(field, index) },
      addServer: () => { this.addServer() },
      removeServer: (serverName) => { this.removeServer(serverName) },
      importServers: () => { void this.importServers() },
    }
  }

  private snapshot(): McpConfigSnapshot {
    return this.config.getSnapshot()
  }

  private authoritative(): Record<string, McpServer> {
    const value = this.snapshot().value
    return value?.servers ?? {}
  }

  private current(): Record<string, McpServer> {
    return this.draft ?? this.authoritative()
  }

  private rows(): McpServerRow[] {
    const issues = this.snapshot().format?.issues ?? []
    return Object.entries(this.current()).map(([serverName, server]) => {
      const serverIssues = issues.filter(issue => issue.serverName === serverName)
      const format = serverIssues.some(issue => issue.severity === 'error')
        ? 'error'
        : serverIssues.length > 0 ? 'warning' : 'valid'
      return {
        serverName,
        transport: server.transport,
        target: server.transport === 'stdio' ? server.command ?? '' : server.url ?? '',
        format,
      }
    })
  }

  private formInvalid(form: McpDraftForm): boolean {
    const parsed = parseForm(form, this.editingName !== null)
    if (parsed === undefined) return true
    if (form.serverName !== this.editingName && Object.hasOwn(this.current(), form.serverName)) return true
    // The Host rejects renaming onto any configured name, even one staged for removal.
    if (this.editingName !== null && form.serverName !== this.editingName
      && Object.hasOwn(this.draft === null ? this.authoritative() : this.draftBase, form.serverName)) return true
    const originalName = this.editingName === null ? undefined
      : this.draft === null
        ? (Object.hasOwn(this.formBase ?? {}, this.editingName) ? this.editingName : undefined)
        : this.draftOrigins.get(this.editingName)
    const original = originalName === undefined ? undefined : (this.formBase ?? this.authoritative())[originalName]
    const map = parsed.transport === 'stdio' ? parsed.env ?? {} : parsed.headers ?? {}
    const oldMap = original?.transport === parsed.transport
      ? (original.transport === 'stdio' ? original.env ?? {} : original.headers ?? {}) : {}
    return Object.entries(map).some(([key, value]) => value === SECRET_MASK && !Object.hasOwn(oldMap, key))
  }

  private projection(): McpCardState {
    const snapshot = this.snapshot()
    const form = this.form
    const servers = this.rows()
    const currentNames = new Set(servers.map(server => server.serverName))
    const formatIssues = (snapshot.format?.issues ?? []).filter(issue => currentNames.has(issue.serverName))
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: this.draft !== null,
      invalid: form !== null,
      saving: this.saving,
      failed: this.failed,
      servers,
      form,
      editingName: this.editingName,
      formInvalid: form !== null && this.formInvalid(form),
      format: {
        valid: formatIssues.length === 0,
        serverCount: servers.length,
        issues: formatIssues,
      },
      importing: this.importing,
      importResult: this.importResult,
    }
  }

  private setForm(field: McpTextField, text: string): void {
    if (this.form === null) return
    this.form = { ...this.form, [field]: text }
    this.importResult = null
    this.publish()
  }

  private editRow(field: McpListField, index: number, part: 'value' | 'key', text: string): void {
    const form = this.form
    if (form === null) return
    if (field === 'args') {
      if (index >= form.args.length) return
      const rows = [...form.args]
      rows[index] = text
      this.form = { ...form, args: rows }
    } else {
      const current = form[field][index]
      if (current === undefined) return
      const rows = [...form[field]]
      rows[index] = { ...current, [part]: text }
      this.form = { ...form, [field]: rows }
    }
    this.importResult = null
    this.publish()
  }

  private appendRow(field: McpListField): void {
    const form = this.form
    if (form === null) return
    this.form = field === 'args'
      ? { ...form, args: [...form.args, ''] }
      : { ...form, [field]: [...form[field], { key: '', value: '' }] }
    this.importResult = null
    this.publish()
  }

  private openEditForm(serverName: string): void {
    if (this.form !== null || this.saving || this.importing || !this.snapshot().writable) return
    const server = this.current()[serverName]
    if (server === undefined) return
    this.captureFormBase()
    this.editingName = serverName
    this.form = formFor(serverName, server)
    this.publish()
  }

  private captureFormBase(): void {
    this.formBase = this.draft === null ? { ...this.authoritative() } : null
    this.formRevision = this.draft === null ? this.snapshot().revision : undefined
  }

  private closeForm(): void {
    this.form = null
    this.editingName = null
    this.formBase = null
    this.formRevision = undefined
  }

  private removeRow(field: McpListField, index: number): void {
    const form = this.form
    if (form === null) return
    this.form = field === 'args'
      ? { ...form, args: form.args.filter((_, at) => at !== index) }
      : { ...form, [field]: form[field].filter((_, at) => at !== index) }
    this.importResult = null
    this.publish()
  }

  private addServer(): void {
    if (this.form === null || this.saving || !this.snapshot().writable) return
    if (this.formInvalid(this.form)) return
    const server = parseForm(this.form, this.editingName !== null)
    if (server === undefined) return
    const previousName = this.editingName
    if (previousName !== null && previousName === this.form.serverName
      && JSON.stringify(this.current()[previousName]) === JSON.stringify(server)) {
      this.closeForm()
      this.publish()
      return
    }
    const draft = this.draft ?? this.beginDraft(this.formBase ?? this.authoritative(), this.formRevision)
    if (previousName !== null) {
      const origin = this.draftOrigins.get(previousName)
      this.draftOrigins.delete(previousName)
      if (origin !== undefined) this.draftOrigins.set(this.form.serverName, origin)
      delete draft[previousName]
    }
    draft[this.form.serverName] = server
    this.closeForm()
    this.failed = false
    this.importResult = null
    this.publish()
  }

  private removeServer(serverName: string): void {
    if (this.form !== null || this.saving || !this.snapshot().writable
      || !Object.hasOwn(this.current(), serverName)) return
    const draft = this.draft ?? this.beginDraft()
    this.draft = Object.fromEntries(Object.entries(draft).filter(([name]) => name !== serverName))
    this.draftOrigins.delete(serverName)
    this.failed = false
    this.importResult = null
    this.publish()
  }

  private beginDraft(base = this.authoritative(), revision = this.snapshot().revision): Record<string, McpServer> {
    this.draftBase = { ...base }
    this.draftRevision = revision
    this.draft = { ...this.draftBase }
    this.draftOrigins = new Map(Object.keys(this.draftBase).map(name => [name, name]))
    return this.draft
  }

  private async save(): Promise<void> {
    const draft = this.draft
    if (draft === null || this.form !== null || this.saving || !this.snapshot().writable) return
    this.saving = true
    this.failed = false
    this.publish()
    try {
      const ops = planOps(this.draftBase, draft, this.draftOrigins)
      const landed = ops.length > 0 ? await this.config.mutate(ops, this.draftRevision) : true
      // The authoritative read-back is masked, so compare server names.
      const names = Object.keys(this.authoritative()).sort().join('\u{0}')
      const staged = Object.keys(draft).sort().join('\u{0}')
      if (landed && names === staged) {
        this.draft = null
        this.draftOrigins.clear()
      }
      this.failed = !(landed && names === staged)
    } catch {
      this.failed = true
    } finally {
      this.saving = false
      this.publish()
    }
  }

  /** Run the combined one-click import without exposing external definitions to the card. */
  private async importServers(): Promise<void> {
    const snapshot = this.snapshot()
    if (!snapshot.writable || this.importing || this.saving || this.draft !== null || this.form !== null) return
    this.importing = true
    this.failed = false
    this.importResult = null
    this.publish()
    let summary: McpImportSummary | undefined
    try {
      summary = await this.config.importServers(['claude-code', 'codex'], snapshot.revision)
    } catch {
      summary = undefined
    }
    this.importing = false
    this.importResult = summary ?? null
    this.failed = summary === undefined
    this.publish()
  }

  private discard(): void {
    if (this.draft === null && this.form === null && !this.failed) return
    this.draft = null
    this.draftOrigins.clear()
    this.closeForm()
    this.failed = false
    this.importResult = null
    this.publish()
  }

  private publish(): void {
    this.store.set(this.projection())
  }
}
