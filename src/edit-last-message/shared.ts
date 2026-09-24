import type { ContextFormed } from '@deepseek-ai/dsh-llm'

/** Own the producer kind written into current durable Session messages. */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'edit-last-message': { kind: 'edit-last-message'; version: 2; rootMessageId: string } & ContextFormed
  }
}

/** Normalized edit identity decoded from current or historical message sources. */
export interface EditLastMessageSource {
  readonly kind: typeof EDIT_LAST_MESSAGE_SOURCE_KIND
  readonly version: 1
  /** Historical coordinate hint only; resolve rootMessageId against the current log after migration. */
  readonly rootSeq?: number
  /** Message identity of that first user event, used to locate its rendered row. */
  readonly rootMessageId: string
}

interface LegacyEditLastMessageSource {
  readonly kind: 'plugin'
  readonly plugin: typeof EDIT_LAST_MESSAGE_PLUGIN
  readonly editLastMessage: Omit<EditLastMessageSource, 'kind'>
}

export const EDIT_LAST_MESSAGE_SOURCE_KIND = 'edit-last-message' as const
export const EDIT_LAST_MESSAGE_PLUGIN = 'edit-last-message' as const
/** Historical V3 plugin attribution; V3-to-V4 migration prefixes it with `plugin:`. */
export const EDIT_SOURCE_PREFIX = 'dsh-enhanced/edit-last-message/v2/'

/** Create V4 producer-owned attribution using a stable message identity, never an event sequence. */
export function createEditSource(rootMessageId: string): { kind: 'edit-last-message'; version: 2; rootMessageId: string } {
  if (rootMessageId.length === 0) throw new Error('edit root message identity is empty')
  return { kind: EDIT_LAST_MESSAGE_SOURCE_KIND, version: 2, rootMessageId }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function editMarker(value: unknown): Omit<EditLastMessageSource, 'kind'> | undefined {
  if (!isPlainObject(value)
    || value['version'] !== 1
    || typeof value['rootSeq'] !== 'number'
    || !Number.isSafeInteger(value['rootSeq'])
    || value['rootSeq'] < 0
    || typeof value['rootMessageId'] !== 'string'
    || value['rootMessageId'].length === 0) return
  return {
    version: 1,
    rootSeq: value['rootSeq'],
    rootMessageId: value['rootMessageId'],
  }
}

/**
 * Normalize current attribution and historical markers. Legacy rootSeq is a
 * hint only: migrations renumber events, while rootMessageId remains stable.
 */
export function editLastMessageSource(value: unknown): EditLastMessageSource | undefined {
  if (!isPlainObject(value)) return
  if (value['kind'] === EDIT_LAST_MESSAGE_SOURCE_KIND && value['version'] === 2
    && typeof value['rootMessageId'] === 'string' && value['rootMessageId'].length > 0) {
    return { kind: EDIT_LAST_MESSAGE_SOURCE_KIND, version: 1, rootMessageId: value['rootMessageId'] }
  }
  const encoded = value['kind'] === 'plugin' && typeof value['plugin'] === 'string' && value['plugin'].startsWith(EDIT_SOURCE_PREFIX)
    ? value['plugin'].slice(EDIT_SOURCE_PREFIX.length)
    : typeof value['kind'] === 'string' && value['kind'].startsWith(`plugin:${EDIT_SOURCE_PREFIX}`)
      ? value['kind'].slice(`plugin:${EDIT_SOURCE_PREFIX}`.length)
      : undefined
  if (encoded !== undefined) {
    try {
      const rootMessageId = decodeURIComponent(encoded)
      if (rootMessageId.length > 0) return { kind: EDIT_LAST_MESSAGE_SOURCE_KIND, version: 1, rootMessageId }
    } catch { /* Invalid attribution is not an editable message. */ }
    return
  }
  if (value['kind'] === EDIT_LAST_MESSAGE_SOURCE_KIND) {
    const marker = editMarker(value)
    return marker === undefined ? undefined : { kind: EDIT_LAST_MESSAGE_SOURCE_KIND, ...marker }
  }
  if (value['kind'] !== 'plugin' || value['plugin'] !== EDIT_LAST_MESSAGE_PLUGIN) return
  const legacy = value as unknown as Partial<LegacyEditLastMessageSource>
  const marker = editMarker(legacy.editLastMessage)
  return marker === undefined ? undefined : { kind: EDIT_LAST_MESSAGE_SOURCE_KIND, ...marker }
}
