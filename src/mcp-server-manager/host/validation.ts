/**
 * Format validation for the resolved MCP server record.
 *
 * The Schemastery schema owns structural typing and defaults. These checks
 * cover constraints that are awkward or unsafe to express there: URL
 * protocols, HTTP header syntax, control characters, and hidden surrounding
 * whitespace. Reports contain paths and codes only, never field values.
 */

import { SERVER_NAME_PATTERN, type Config, type ServerDefinition } from './schema.js'

/** Stable issue codes shared with configuration clients. */
export type McpFormatIssueCode =
  | 'invalid-name'
  | 'missing-command'
  | 'invalid-url'
  | 'invalid-timeout'
  | 'invalid-header-name'
  | 'invalid-character'
  | 'surrounding-whitespace'

/** One value-free format diagnostic. */
export interface McpFormatIssue {
  /** Server record key carrying the issue. */
  serverName: string
  /** Dotted field path, with map keys but without their values. */
  field: string
  /** Stable machine-readable reason. */
  code: McpFormatIssueCode
  /** Errors refuse settings writes; warnings are surfaced but remain usable. */
  severity: 'error' | 'warning'
}

/** Format audit returned with every configuration view. */
export interface McpFormatReport {
  /** True when no errors or warnings were found. */
  valid: boolean
  /** Number of configured servers inspected. */
  serverCount: number
  /** Value-free diagnostics in server/field order. */
  issues: McpFormatIssue[]
}

const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const COMMAND_CONTROL_PATTERN = /[\u0000-\u001F\u007F]/
const HEADER_VALUE_CONTROL_PATTERN = /[\u0000\u000A\u000D]/

/** Keep untrusted map keys useful in a field path without forwarding controls or unbounded text. */
function mapField(prefix: 'env' | 'headers', key: string): string {
  const component = key.replace(/[\u0000-\u001F\u007F]/g, '�').slice(0, 80)
  return `${prefix}.${component === '' ? '<empty>' : component}`
}

/** Append a hidden-whitespace warning without exposing the value. */
function checkWhitespace(
  issues: McpFormatIssue[],
  serverName: string,
  field: string,
  value: string,
): void {
  if (value.trim() === value) return
  issues.push({ serverName, field, code: 'surrounding-whitespace', severity: 'warning' })
}

/** Append an invalid-character error without exposing the value. */
function checkControlCharacters(
  issues: McpFormatIssue[],
  serverName: string,
  field: string,
  value: string,
  pattern: RegExp = COMMAND_CONTROL_PATTERN,
): void {
  if (!pattern.test(value)) return
  issues.push({ serverName, field, code: 'invalid-character', severity: 'error' })
}

/** Validate the transport-specific fields of one resolved definition. */
function inspectServer(serverName: string, definition: ServerDefinition): McpFormatIssue[] {
  const issues: McpFormatIssue[] = []
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    issues.push({ serverName, field: 'serverName', code: 'invalid-name', severity: 'error' })
  }
  if (!Number.isFinite(definition.toolCallTimeoutMs) || definition.toolCallTimeoutMs < 1) {
    issues.push({ serverName, field: 'toolCallTimeoutMs', code: 'invalid-timeout', severity: 'error' })
  }

  if (definition.transport === 'stdio') {
    if (definition.command.trim() === '') {
      issues.push({ serverName, field: 'command', code: 'missing-command', severity: 'error' })
    }
    checkWhitespace(issues, serverName, 'command', definition.command)
    checkControlCharacters(issues, serverName, 'command', definition.command)
    definition.args.forEach((argument, index) => {
      const field = `args.${String(index)}`
      checkWhitespace(issues, serverName, field, argument)
      checkControlCharacters(issues, serverName, field, argument)
    })
    checkWhitespace(issues, serverName, 'cwd', definition.cwd)
    checkControlCharacters(issues, serverName, 'cwd', definition.cwd)
    for (const [key, value] of Object.entries(definition.env)) {
      const field = mapField('env', key)
      checkWhitespace(issues, serverName, field, key)
      checkWhitespace(issues, serverName, field, value)
      checkControlCharacters(issues, serverName, field, key)
      checkControlCharacters(issues, serverName, field, value)
    }
    return issues
  }

  checkWhitespace(issues, serverName, 'url', definition.url)
  checkControlCharacters(issues, serverName, 'url', definition.url)
  try {
    const url = new URL(definition.url)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') {
      issues.push({ serverName, field: 'url', code: 'invalid-url', severity: 'error' })
    }
  } catch {
    issues.push({ serverName, field: 'url', code: 'invalid-url', severity: 'error' })
  }
  for (const [key, value] of Object.entries(definition.headers)) {
    const field = mapField('headers', key)
    checkWhitespace(issues, serverName, field, key)
    checkWhitespace(issues, serverName, field, value)
    if (!HEADER_NAME_PATTERN.test(key)) {
      issues.push({ serverName, field, code: 'invalid-header-name', severity: 'error' })
    }
    checkControlCharacters(issues, serverName, field, value, HEADER_VALUE_CONTROL_PATTERN)
  }
  return issues
}

/**
 * Inspect a resolved MCP settings section.
 * @param config - schema-resolved server record.
 * @returns a value-free report suitable for the browser wire.
 */
export function inspectMcpConfig(config: Config): McpFormatReport {
  const issues = Object.entries(config.servers).flatMap(([serverName, definition]) => (
    inspectServer(serverName, definition)
  ))
  return {
    valid: issues.length === 0,
    serverCount: Object.keys(config.servers).length,
    issues,
  }
}

/**
 * Refuse a resolved section containing format errors the schema cannot express.
 * Warnings remain visible through {@link inspectMcpConfig} but do not refuse a
 * write. Error text names paths and codes only, so credentials never leak.
 * @param config - schema-resolved server record.
 */
export function assertMcpConfigValid(config: Config): void {
  const errors = inspectMcpConfig(config).issues.filter(issue => issue.severity === 'error')
  if (errors.length === 0) return
  const summary = errors.map(issue => `${issue.serverName}.${issue.field}: ${issue.code}`).join('; ')
  throw new TypeError(`mcp-manager: invalid MCP configuration (${summary})`)
}
