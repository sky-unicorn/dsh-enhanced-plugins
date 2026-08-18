let id = 0

export function createUserMessage<T extends { content: unknown[]; source: unknown }>(input: T) {
  id += 1
  return Object.freeze({ ...input, id: `test-message-${id}`, role: 'user' as const })
}

export interface UserMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: Array<{ type: string; text?: string }>
  readonly source: { kind: string; plugin?: string }
}
