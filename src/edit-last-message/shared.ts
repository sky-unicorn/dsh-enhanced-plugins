/** Durable source carried by a replacement user message created by this plugin. */
export interface EditLastMessageSource {
  readonly kind: typeof EDIT_LAST_MESSAGE_SOURCE_KIND
  readonly version: 1
  /** First user event whose visible position this edited turn owns. */
  readonly rootSeq: number
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
 * Narrow and normalize this plugin's durable message source. The legacy arm
 * keeps already-loaded pre-fix sessions usable; new records use their own
 * merge-extensible `kind` so released DSH format readers can preserve them.
 */
export function editLastMessageSource(value: unknown): EditLastMessageSource | undefined {
  if (!isPlainObject(value)) return
  if (value['kind'] === EDIT_LAST_MESSAGE_SOURCE_KIND) {
    const marker = editMarker(value)
    return marker === undefined ? undefined : { kind: EDIT_LAST_MESSAGE_SOURCE_KIND, ...marker }
  }
  if (value['kind'] !== 'plugin' || value['plugin'] !== EDIT_LAST_MESSAGE_PLUGIN) return
  const legacy = value as unknown as Partial<LegacyEditLastMessageSource>
  const marker = editMarker(legacy.editLastMessage)
  return marker === undefined ? undefined : { kind: EDIT_LAST_MESSAGE_SOURCE_KIND, ...marker }
}
