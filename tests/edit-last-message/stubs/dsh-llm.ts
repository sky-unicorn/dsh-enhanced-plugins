let nextId = 0

export function createUserMessage(input: { content: unknown[]; source: unknown }) {
  nextId += 1
  return { ...input, id: `replacement-${nextId}`, role: 'user' as const }
}
