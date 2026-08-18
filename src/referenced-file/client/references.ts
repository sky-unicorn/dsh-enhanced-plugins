/** Active unquoted # query in the textarea. */
export interface HashTriggerHit {
  start: number
  end: number
  query: string
}

/**
 * Detect an active # token ending at the caret. Selected references use the
 * explicit `#<path>` form and therefore never reopen the candidate menu.
 */
export function detectHashTrigger(draft: string, caret: number): HashTriggerHit | undefined {
  if (!Number.isInteger(caret) || caret < 0 || caret > draft.length) return undefined
  let start = caret
  while (start > 0 && !/\s/u.test(draft[start - 1] ?? '')) start -= 1
  const token = draft.slice(start, caret)
  if (!token.startsWith('#') || token.startsWith('#<') || token.includes('\n')) return undefined
  if (start > 0 && !/\s/u.test(draft[start - 1] ?? '')) return undefined
  const query = token.slice(1)
  if (/[<>"'`,;!?()[\]{}]/u.test(query)) return undefined
  return { start, end: caret, query }
}

/** Encode a workspace-relative path as an explicit, unambiguous # marker. */
export function formatFileReference(path: string): string {
  return `#<${path.replaceAll('\\', '\\\\').replaceAll('>', '\\>')}>`
}

/** Replace the active # query and leave one separator before following text. */
export function replaceHashTrigger(draft: string, hit: HashTriggerHit, path: string): { draft: string; caret: number } {
  const marker = formatFileReference(path)
  const suffix = draft.slice(hit.end)
  const separator = suffix === '' || /^\s/u.test(suffix) ? '' : ' '
  const next = draft.slice(0, hit.start) + marker + separator + suffix
  return { draft: next, caret: hit.start + marker.length + separator.length }
}
