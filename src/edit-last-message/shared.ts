/** Durable marker carried by a replacement user message created by this plugin. */
export interface EditLastMessageMarker {
  readonly version: 1
  /** First user event whose visible position this edited turn owns. */
  readonly rootSeq: number
  /** Message identity of that first user event, used to locate its rendered row. */
  readonly rootMessageId: string
}

/** Message-source shape used by the Host replacement and Client projection. */
export interface EditLastMessageSource {
  readonly kind: 'plugin'
  readonly plugin: typeof EDIT_LAST_MESSAGE_PLUGIN
  readonly editLastMessage: EditLastMessageMarker
}

export const EDIT_LAST_MESSAGE_PLUGIN = 'edit-last-message' as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Narrow an untrusted message source to this plugin's durable edit marker. */
export function editLastMessageSource(value: unknown): EditLastMessageSource | undefined {
  if (!isPlainObject(value)
    || value['kind'] !== 'plugin'
    || value['plugin'] !== EDIT_LAST_MESSAGE_PLUGIN
    || !isPlainObject(value['editLastMessage'])) return
  const marker = value['editLastMessage']
  if (marker['version'] !== 1
    || typeof marker['rootSeq'] !== 'number'
    || !Number.isSafeInteger(marker['rootSeq'])
    || marker['rootSeq'] < 0
    || typeof marker['rootMessageId'] !== 'string'
    || marker['rootMessageId'].length === 0) return
  return value as unknown as EditLastMessageSource
}
