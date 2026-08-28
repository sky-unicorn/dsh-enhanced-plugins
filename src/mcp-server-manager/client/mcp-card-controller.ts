/**
 * The MCP card's staged form over the `mcp` namespace, served through the
 * `mcpConfig` Remote store.
 *
 * This card edits a whole server record: it stages a detached copy of the
 * authoritative `servers` map and applies add/remove edits to it, then writes
 * the change as path-addressed ops on save - one `set` per added server, one
 * `unset` per removed server, nothing for the rest, so stored secrets this
 * card only ever reads masked are never restated. Server fields are staged
 * as draft rows - one input per argument, one key-value pair row per
 * variable or header - and parsed into the record only when an add is
 * committed, so an invalid row blocks the save instead of being discarded.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  McpConfigSnapshot, McpFormatReport, McpImportSource, McpImportSummary, McpWireOp,
} from './mcp-config-store.ts'

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
export const MCP_NS = 'mcp'

/** The `serverName` contract, kept in sync with the manager's key pattern. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** One stdio server's editable fields (all optional in the wire section). */
export interface StdioMcpServer {
  transport: 'stdio'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

/** One Streamable HTTP server's editable fields. */
export interface StreamableHttpMcpServer {
  transport: 'streamable-http'
  url?: string
  headers?: Record<string, string>
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

/** One key-value row in the add form's `env`/`headers` lists. */
export interface DraftPair {
  /** The variable or header name. */
  key: string
  /** The variable or header value. */
  value: string
}

/** The add-server form's draft fields: text fields as strings, list fields as rows. */
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
}

/** Add-form fields staged as a single text value. */
export type McpTextField = 'serverName' | 'transport' | 'command' | 'url' | 'cwd'

/** Add-form fields staged as editable row lists. */
export type McpListField = 'args' | 'env' | 'headers'

/** What the MCP card renders. */
export interface McpCardState extends CardShell {
  /** The servers the card currently shows (draft when dirty, else the document). */
  servers: McpServerRow[]
  /** The add form, present while open. */
  form: McpDraftForm | null
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
  /** Commit the add form into the staged record. */
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
 * with a repeated key overwrites the earlier one.
 * @param rows - the staged key-value rows.
 * @returns the committed record, or undefined when a row has a value but no key.
 */
export function collectPairs(rows: readonly DraftPair[]): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    const value = row.value.trim()
    if (key === '' && value === '') continue
    if (key === '') return undefined
    out[key] = value
  }
  return out
}

/** Build the server definition the add form describes, or undefined when invalid. */
function parseForm(form: McpDraftForm): McpServer | undefined {
  if (!SERVER_NAME_PATTERN.test(form.serverName)) return undefined
  if (form.transport === 'stdio') {
    if (form.command.trim() === '') return undefined
    const env = collectPairs(form.env)
    if (env === undefined) return undefined
    const args = collectArgs(form.args)
    return {
      transport: 'stdio',
      command: form.command.trim(),
      ...args.length > 0 ? { args } : {},
      ...Object.keys(env).length > 0 ? { env } : {},
      ...form.cwd.trim() !== '' ? { cwd: form.cwd.trim() } : {},
    }
  }
  if (!isValidHttpUrl(form.url.trim())) return undefined
  const headers = collectPairs(form.headers)
  if (headers === undefined || Object.keys(headers).some(key => !HEADER_NAME_PATTERN.test(key))) return undefined
  return {
    transport: 'streamable-http',
    url: form.url.trim(),
    ...Object.keys(headers).length > 0 ? { headers } : {},
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
 * Plan the path ops a save writes: one `set` per added server, one `unset`
 * per removed server, nothing for unchanged ones. Unchanged entries keep
 * their stored secrets exactly because no op restates a masked read.
 * @param authoritative - the masked record the draft was staged over.
 * @param draft - the staged record.
 * @returns the ordered ops for `mcpConfig/mutate`.
 */
export function planOps(
  authoritative: Record<string, McpServer>,
  draft: Record<string, McpServer>,
): McpWireOp[] {
  const ops: McpWireOp[] = []
  for (const [serverName, server] of Object.entries(draft)) {
    const previous = authoritative[serverName]
    if (previous !== undefined && JSON.stringify(server) === JSON.stringify(previous)) continue
    ops.push({ op: 'set', path: ['servers', serverName], value: server })
  }
  for (const serverName of Object.keys(authoritative)) {
    if (!(serverName in draft)) ops.push({ op: 'unset', path: ['servers', serverName] })
  }
  return ops
}

/** Bridges the `mcpConfig` store onto the MCP card's staged server record. */
export class McpCardController {
  private readonly store: SnapshotStore<McpCardState>
  /** Detached staged record; null while not dirty. */
  private draft: Record<string, McpServer> | null = null
  /** The add form; null while closed. */
  private form: McpDraftForm | null = null
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
      openForm: () => { this.form = emptyForm(); this.publish() },
      closeForm: () => { this.form = null; this.publish() },
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
    if (parseForm(form) === undefined) return true
    // A duplicate serverName is refused by the manager, so the card blocks it too.
    return Object.hasOwn(this.current(), form.serverName)
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
      invalid: form !== null && this.formInvalid(form),
      saving: this.saving,
      failed: this.failed,
      servers,
      form,
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
    if (this.form === null) return
    const server = parseForm(this.form)
    if (server === undefined || Object.hasOwn(this.current(), this.form.serverName)) return
    if (this.draft === null) this.draft = { ...this.authoritative() }
    this.draft[this.form.serverName] = server
    this.form = null
    this.failed = false
    this.importResult = null
    this.publish()
  }

  private removeServer(serverName: string): void {
    if (this.draft === null) this.draft = { ...this.authoritative() }
    this.draft = Object.fromEntries(Object.entries(this.draft).filter(([name]) => name !== serverName))
    this.failed = false
    this.importResult = null
    this.publish()
  }

  private async save(): Promise<void> {
    const draft = this.draft
    if (draft === null || this.saving) return
    this.saving = true
    this.failed = false
    this.publish()
    const ops = planOps(this.authoritative(), draft)
    const landed = ops.length > 0 ? await this.config.mutate(ops, this.snapshot().revision) : true
    // The authoritative read-back is masked, so the honest landing check is
    // the record's keys: every name the draft holds is served, every removed
    // one is gone. Values are the Host's schema-validated contract.
    const names = Object.keys(this.authoritative()).sort().join('\u{0}')
    const staged = Object.keys(draft).sort().join('\u{0}')
    if (landed && names === staged) this.draft = null
    this.saving = false
    this.failed = !(landed && names === staged)
    this.publish()
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
    this.form = null
    this.failed = false
    this.importResult = null
    this.publish()
  }

  private publish(): void {
    this.store.set(this.projection())
  }
}
