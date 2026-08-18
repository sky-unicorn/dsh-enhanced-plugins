/**
 * The MCP card: the servers the agent can reach through the MCP manager, with
 * an add form for a new stdio or Streamable HTTP server and a remove per row.
 * Every edit stages into a detached record and lands on one save.
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import clsx from 'clsx'
import {
  Button, IconCheckOutline14, IconCodeOutline16, IconDownloadOutline16,
  IconGlobeOutline14, IconPlusOutline16, IconTrashOutline16, IconWarningOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: loads the `settings.plugin.item` SlotMap declaration the props
// below name; cross-package collaboration goes through the slot, never a
// value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { McpCardShell } from './McpCardShell.tsx'
import {
  isValidHttpUrl, SERVER_NAME_PATTERN,
  type DraftPair, type McpCardFace, type McpDraftForm, type McpListField, type McpTextField,
} from './mcp-card-controller.ts'
import type { McpFormatIssueCode, McpImportIssue, McpImportIssueCode, McpImportSummary } from './mcp-config-store.ts'
import type { McpSettingsLocaleKey } from './locales.ts'
import fieldCss from './fields.module.css'

const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** Props the renderer binds for the MCP card. */
export type McpCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.mcp'>
  & InjectFace<McpCardFace>

/**
 * Render the MCP card.
 * @param props - locale copy, the card snapshot, and its list-editing actions.
 * @returns the card.
 */
export function McpCard(props: McpCardProps) {
  const { t } = props
  const state = props.useMcpCard(snapshot => snapshot)
  const disabled = !state.writable
  const importDisabled = disabled || state.dirty || state.form !== null || state.saving || state.importing
  return (
    <McpCardShell
      t={t}
      titleKey="mcpTitle"
      descriptionKey="mcpDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <div className={fieldCss.overview}>
        <div
          className={clsx(
            fieldCss.formatStatus,
            state.format.issues.length > 0 && fieldCss.formatStatusWarning,
          )}
          role="status"
        >
          {state.format.issues.length === 0
            ? <IconCheckOutline14 className={fieldCss.statusIcon} />
            : <IconWarningOutline16 size={14} className={fieldCss.statusIcon} />}
          <span>{formatSummary(t, state.format.serverCount, state.format.issues.length)}</span>
        </div>
        <span className={fieldCss.count}>{template(t('mcpConfiguredCount'), { count: state.servers.length })}</span>
      </div>

      {state.format.issues.length > 0
        ? (
          <ul className={fieldCss.issueList} aria-label={t('mcpFormatIssues')}>
            {state.format.issues.map((issue, index) => (
              <li key={`${issue.serverName}:${issue.field}:${String(index)}`}>
                <span className={fieldCss.issueServer}>{issue.serverName}</span>
                <span className={fieldCss.issueField}>{issue.field}</span>
                <span>{formatIssueCopy(t, issue.code)}</span>
              </li>
            ))}
          </ul>
        )
        : null}

      {state.servers.length === 0
        ? (
          <div className={fieldCss.emptyState}>
            <IconCodeOutline16 className={fieldCss.emptyIcon} />
            <span className={fieldCss.emptyTitle}>{t('mcpEmpty')}</span>
            <span className={fieldCss.emptyHint}>{t('mcpEmptyHint')}</span>
          </div>
        )
        : (
          <ul className={fieldCss.serverList}>
            {state.servers.map(server => (
              <li key={server.serverName} className={fieldCss.serverRow}>
                <span className={fieldCss.transportIcon} aria-hidden>
                  {server.transport === 'stdio' ? <IconCodeOutline16 /> : <IconGlobeOutline14 size={16} />}
                </span>
                <span className={fieldCss.serverDetails}>
                  <span className={fieldCss.serverHeading}>
                    <span className={fieldCss.serverName}>{server.serverName}</span>
                    <span className={fieldCss.transportBadge}>
                      {t(server.transport === 'stdio' ? 'mcpTransportBadgeStdio' : 'mcpTransportBadgeHttp')}
                    </span>
                    <span
                      className={clsx(fieldCss.rowStatus, server.format !== 'valid' && fieldCss.rowStatusWarning)}
                      aria-label={t(server.format === 'valid' ? 'mcpFormatRowValid' : 'mcpFormatRowWarning')}
                      title={t(server.format === 'valid' ? 'mcpFormatRowValid' : 'mcpFormatRowWarning')}
                    >
                      {server.format === 'valid' ? <IconCheckOutline14 /> : <IconWarningOutline16 size={14} />}
                    </span>
                  </span>
                  <span className={fieldCss.serverTarget}>{server.target}</span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className={fieldCss.remove}
                  disabled={disabled}
                  icon={<IconTrashOutline16 />}
                  onClick={() => { props.removeServer(server.serverName) }}
                >
                  {t('mcpRemove')}
                </Button>
              </li>
            ))}
          </ul>
        )}

      <div className={fieldCss.importPanel}>
        <span className={fieldCss.importCopy}>
          <span className={fieldCss.importTitle}>{t('mcpImportTitle')}</span>
          <span className={fieldCss.importHint}>{t('mcpImportHint')}</span>
        </span>
        <Button
          variant="primary"
          size="sm"
          disabled={importDisabled}
          icon={state.importing ? undefined : <IconDownloadOutline16 />}
          onClick={props.importServers}
        >
          {t(state.importing ? 'mcpImporting' : 'mcpImportButton')}
        </Button>
      </div>
      {state.importResult !== null ? <ImportResult t={t} summary={state.importResult} /> : null}

      {state.form === null
        ? (
          <Button
            variant="outline"
            size="sm"
            className={fieldCss.addServer}
            disabled={disabled || state.importing}
            icon={<IconPlusOutline16 />}
            onClick={props.openForm}
          >
            {t('mcpAddServer')}
          </Button>
        )
        : (
          <AddServerForm
            t={t}
            form={state.form}
            disabled={disabled}
            invalid={state.formInvalid}
            nameInvalid={
              (state.form.serverName !== '' && !SERVER_NAME_PATTERN.test(state.form.serverName))
              || state.servers.some(server => server.serverName === state.form?.serverName)
            }
            onEdit={props.editForm}
            onEditRow={props.editListRow}
            onAppendRow={props.appendListRow}
            onRemoveRow={props.removeListRow}
            onAdd={props.addServer}
            onCancel={props.closeForm}
          />
        )}
    </McpCardShell>
  )
}

/** Replace simple locale placeholders without putting copy in the component. */
function template(copy: string, values: Readonly<Record<string, string | number>>): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, String(value)),
    copy,
  )
}

/** Localized summary of the Host's current format audit. */
function formatSummary(t: McpCardProps['t'], serverCount: number, issueCount: number): string {
  return template(t(issueCount === 0 ? 'mcpFormatValid' : 'mcpFormatWarning'), {
    count: serverCount,
    issues: issueCount,
  })
}

/** Localized, value-free format issue reason. */
function formatIssueCopy(t: McpCardProps['t'], code: McpFormatIssueCode): string {
  const keys: Record<McpFormatIssueCode, McpSettingsLocaleKey> = {
    'invalid-name': 'mcpFormatInvalidName',
    'missing-command': 'mcpFormatMissingCommand',
    'invalid-url': 'mcpFormatInvalidUrl',
    'invalid-timeout': 'mcpFormatInvalidTimeout',
    'invalid-header-name': 'mcpFormatInvalidHeader',
    'invalid-character': 'mcpFormatInvalidCharacter',
    'surrounding-whitespace': 'mcpFormatWhitespace',
  }
  return t(keys[code])
}

/** Localized external source label. */
function sourceCopy(t: McpCardProps['t'], source: McpImportIssue['source']): string {
  return t(source === 'claude-code' ? 'mcpSourceClaudeCode' : 'mcpSourceCodex')
}

/** Localized, value-free external import reason. */
function importIssueCopy(t: McpCardProps['t'], code: McpImportIssueCode): string {
  const keys: Record<McpImportIssueCode, McpSettingsLocaleKey> = {
    'source-unreadable': 'mcpImportSourceUnreadable',
    'source-invalid': 'mcpImportSourceInvalid',
    'server-invalid': 'mcpImportServerInvalid',
    'unsupported-transport': 'mcpImportUnsupportedTransport',
    'unsupported-auth': 'mcpImportUnsupportedAuth',
    'environment-missing': 'mcpImportEnvironmentMissing',
    disabled: 'mcpImportDisabled',
    'ignored-options': 'mcpImportIgnoredOptions',
  }
  return t(keys[code])
}

/** Result callout for the combined Claude Code + Codex import. */
function ImportResult(props: { t: McpCardProps['t']; summary: McpImportSummary }) {
  const { t, summary } = props
  const anySource = summary.found['claude-code'] || summary.found.codex
  return (
    <div className={fieldCss.importResult} role="status" aria-live="polite">
      <span className={fieldCss.importResultTitle}>
        {anySource
          ? template(t('mcpImportResult'), {
            imported: summary.imported,
            duplicates: summary.duplicates,
            renamed: summary.renamed,
            skipped: summary.skipped,
          })
          : t('mcpImportNoSources')}
      </span>
      {summary.importedNames.length > 0
        ? <span className={fieldCss.importNames}>{summary.importedNames.join(', ')}</span>
        : null}
      {summary.issues.length > 0
        ? (
          <ul className={fieldCss.importIssues}>
            {summary.issues.map((issue, index) => (
              <li key={`${issue.source}:${issue.serverName ?? issue.scope}:${issue.code}:${String(index)}`}>
                <span>{sourceCopy(t, issue.source)}</span>
                {issue.serverName === undefined ? null : <span className={fieldCss.issueServer}>{issue.serverName}</span>}
                <span>{importIssueCopy(t, issue.code)}</span>
              </li>
            ))}
          </ul>
        )
        : null}
    </div>
  )
}

/** One labelled text field in the add form. */
function FormField(props: {
  id: string
  label: string
  hint: string
  invalidLabel: string
  text: string
  invalid: boolean
  disabled: boolean
  onEdit: (text: string) => void
}) {
  return (
    <div className={fieldCss.field}>
      <label className={fieldCss.label} htmlFor={props.id}>{props.label}</label>
      <input
        id={props.id}
        className={props.invalid ? fieldCss.inputInvalid : fieldCss.input}
        type="text"
        {...props.invalid ? { 'aria-invalid': true } : {}}
        value={props.text}
        disabled={props.disabled}
        onChange={(event) => { props.onEdit(event.target.value) }}
      />
      <p className={props.invalid ? fieldCss.invalid : fieldCss.hint}>
        {props.invalid ? props.invalidLabel : props.hint}
      </p>
    </div>
  )
}

/** One appendable argument list: each row's input holds one whole argument. */
function ArgsField(props: {
  t: McpCardProps['t']
  rows: string[]
  disabled: boolean
  onEditRow: (index: number, text: string) => void
  onAppend: () => void
  onRemove: (index: number) => void
}) {
  const { t, rows, disabled, onEditRow, onAppend, onRemove } = props
  return (
    <div className={fieldCss.field}>
      <span className={fieldCss.label}>{t('mcpArgs')}</span>
      {rows.map((text, index) => (
        <div className={fieldCss.listRow} key={index}>
          <input
            className={`${fieldCss.input} ${fieldCss.rowInput}`}
            type="text"
            aria-label={`${t('mcpArgRow')} ${String(index + 1)}`}
            placeholder={t('mcpArgPlaceholder')}
            value={text}
            disabled={disabled}
            onChange={(event) => { onEditRow(index, event.target.value) }}
          />
          <Button variant="ghost" size="sm" className={fieldCss.compactRemove} disabled={disabled} onClick={() => { onRemove(index) }}>
            {t('mcpRemove')}
          </Button>
        </div>
      ))}
      <Button variant="ghost" size="sm" className={fieldCss.addRow} disabled={disabled} icon={<IconPlusOutline16 />} onClick={onAppend}>
        {t('mcpAddArg')}
      </Button>
      <p className={fieldCss.hint}>{t('mcpArgsHint')}</p>
    </div>
  )
}

/** One appendable key-value list, rendered per its `env`/`headers` field. */
function KeyValueField(props: {
  t: McpCardProps['t']
  field: 'env' | 'headers'
  rows: DraftPair[]
  disabled: boolean
  onEditRow: (index: number, part: 'key' | 'value', text: string) => void
  onAppend: () => void
  onRemove: (index: number) => void
}) {
  const { t, field, rows, disabled, onEditRow, onAppend, onRemove } = props
  const copy = field === 'env'
    ? {
      label: t('mcpEnv'),
      addLabel: t('mcpAddEnvVar'),
      keyPlaceholder: t('mcpEnvKeyPlaceholder'),
      valuePlaceholder: t('mcpEnvValuePlaceholder'),
      hint: t('mcpEnvHint'),
    }
    : {
      label: t('mcpHeaders'),
      addLabel: t('mcpAddHeader'),
      keyPlaceholder: t('mcpHeaderKeyPlaceholder'),
      valuePlaceholder: t('mcpHeaderValuePlaceholder'),
      hint: t('mcpHeadersHint'),
    }
  const missingKey = rows.some(row => row.key.trim() === '' && row.value.trim() !== '')
  const invalidHeader = field === 'headers' && rows.some(row => (
    row.key.trim() !== '' && !HEADER_NAME_PATTERN.test(row.key.trim())
  ))
  return (
    <div className={fieldCss.field}>
      <span className={fieldCss.label}>{copy.label}</span>
      {rows.map((row, index) => (
        <div className={fieldCss.listRow} key={index}>
          <input
            className={`${invalidHeader && !HEADER_NAME_PATTERN.test(row.key.trim()) ? fieldCss.inputInvalid : fieldCss.input} ${fieldCss.rowInput}`}
            type="text"
            aria-label={`${t('mcpPairKey')} ${String(index + 1)}`}
            placeholder={copy.keyPlaceholder}
            value={row.key}
            disabled={disabled}
            onChange={(event) => { onEditRow(index, 'key', event.target.value) }}
          />
          <input
            className={`${fieldCss.input} ${fieldCss.rowInput}`}
            type="text"
            aria-label={`${t('mcpPairValue')} ${String(index + 1)}`}
            placeholder={copy.valuePlaceholder}
            value={row.value}
            disabled={disabled}
            onChange={(event) => { onEditRow(index, 'value', event.target.value) }}
          />
          <Button variant="ghost" size="sm" className={fieldCss.compactRemove} disabled={disabled} onClick={() => { onRemove(index) }}>
            {t('mcpRemove')}
          </Button>
        </div>
      ))}
      <Button variant="ghost" size="sm" className={fieldCss.addRow} disabled={disabled} icon={<IconPlusOutline16 />} onClick={onAppend}>
        {copy.addLabel}
      </Button>
      <p className={missingKey || invalidHeader ? fieldCss.invalid : fieldCss.hint}>
        {missingKey ? t('mcpPairMissingKey') : invalidHeader ? t('mcpFormatInvalidHeader') : copy.hint}
      </p>
    </div>
  )
}

/** The add-server form. */
function AddServerForm(props: {
  t: McpCardProps['t']
  form: McpDraftForm
  disabled: boolean
  invalid: boolean
  nameInvalid: boolean
  onEdit: (field: McpTextField, text: string) => void
  onEditRow: (field: McpListField, index: number, part: 'value' | 'key', text: string) => void
  onAppendRow: (field: McpListField) => void
  onRemoveRow: (field: McpListField, index: number) => void
  onAdd: () => void
  onCancel: () => void
}) {
  const { t, form, disabled, invalid, nameInvalid, onEdit, onEditRow, onAppendRow, onRemoveRow, onAdd, onCancel } = props
  const transport = form.transport
  return (
    <div className={fieldCss.form}>
      <div className={fieldCss.formHeading}>
        <span className={fieldCss.formTitle}>{t('mcpAddFormTitle')}</span>
        <span className={fieldCss.formSubtitle}>{t('mcpAddFormHint')}</span>
      </div>
      <FormField
        id="mcp-server-name"
        label={t('mcpServerName')}
        hint={t('mcpServerNameHint')}
        invalidLabel={t('mcpInvalidForm')}
        text={form.serverName}
        invalid={nameInvalid}
        disabled={disabled}
        onEdit={(text) => { onEdit('serverName', text) }}
      />

      <div className={fieldCss.field}>
        <label className={fieldCss.label} htmlFor="mcp-transport">{t('mcpTransport')}</label>
        <select
          id="mcp-transport"
          className={fieldCss.input}
          disabled={disabled}
          value={transport}
          onChange={(event) => { onEdit('transport', event.target.value) }}
        >
          <option value="stdio">{t('mcpTransportStdio')}</option>
          <option value="streamable-http">{t('mcpTransportHttp')}</option>
        </select>
      </div>

      {transport === 'stdio'
        ? (
          <>
            <FormField
              id="mcp-command"
              label={t('mcpCommand')}
              hint={t('mcpCommandHint')}
              invalidLabel={t('mcpInvalidForm')}
              text={form.command}
              invalid={invalid && form.serverName.trim() !== '' && form.command.trim() === ''}
              disabled={disabled}
              onEdit={(text) => { onEdit('command', text) }}
            />
            <ArgsField
              t={t}
              rows={form.args}
              disabled={disabled}
              onEditRow={(index, text) => { onEditRow('args', index, 'value', text) }}
              onAppend={() => { onAppendRow('args') }}
              onRemove={(index) => { onRemoveRow('args', index) }}
            />
            <FormField
              id="mcp-cwd"
              label={t('mcpCwd')}
              hint={t('mcpCwdHint')}
              invalidLabel={t('mcpInvalidForm')}
              text={form.cwd}
              invalid={false}
              disabled={disabled}
              onEdit={(text) => { onEdit('cwd', text) }}
            />
            <KeyValueField
              t={t}
              field="env"
              rows={form.env}
              disabled={disabled}
              onEditRow={(index, part, text) => { onEditRow('env', index, part, text) }}
              onAppend={() => { onAppendRow('env') }}
              onRemove={(index) => { onRemoveRow('env', index) }}
            />
          </>
        )
        : (
          <>
            <FormField
              id="mcp-url"
              label={t('mcpUrl')}
              hint={t('mcpUrlHint')}
              invalidLabel={t('mcpInvalidForm')}
              text={form.url}
              invalid={invalid && form.url.trim() !== '' && !isValidHttpUrl(form.url.trim())}
              disabled={disabled}
              onEdit={(text) => { onEdit('url', text) }}
            />
            <KeyValueField
              t={t}
              field="headers"
              rows={form.headers}
              disabled={disabled}
              onEditRow={(index, part, text) => { onEditRow('headers', index, part, text) }}
              onAppend={() => { onAppendRow('headers') }}
              onRemove={(index) => { onRemoveRow('headers', index) }}
            />
          </>
        )}

      <div className={fieldCss.formActions}>
        <Button variant="ghost" size="sm" disabled={disabled} onClick={onCancel}>
          {t('mcpCancel')}
        </Button>
        <Button variant="primary" size="sm" disabled={disabled || invalid} onClick={onAdd}>
          {t('mcpAdd')}
        </Button>
      </div>
    </div>
  )
}
