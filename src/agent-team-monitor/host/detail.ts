import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { MONITOR_PROTOCOL, type ExecutionDetail } from '../shared.js'
import type { CatalogReads } from './catalog.js'

const LIMIT = 6000
const SECRET = /authorization|cookie|password|passwd|secret|api[-_]?key|access[-_]?token|refresh[-_]?token|credential/i
/** Best-effort display redaction; private tool metadata, reasoning and provider errors are never read. */
function redact(text: string): string {
  return text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '$1 [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/((?:api[-_]?key|token|secret|password|authorization|cookie)["']?\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&]+)/gi, '$1[redacted]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
}
function argumentsText(value: string): string {
  try {
    return redact(JSON.stringify(JSON.parse(value), (key, item: unknown) => SECRET.test(key) ? '[redacted]' : item, 2))
  } catch { return redact(value) }
}
function textContent(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value.flatMap((block: unknown) => {
    if (block === null || typeof block !== 'object' || !('type' in block)) return []
    if (block.type === 'text' && 'text' in block && typeof block.text === 'string') return [block.text]
    return []
  }).join('\n')
}

/** Read a verified descendant's own event through public observation; cannot activate a session. */
export async function describeExecutionDetail(reads: CatalogReads, request: unknown, signal: AbortSignal): Promise<ExecutionDetail> {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Invalid execution address')
  const value = request as Record<string, unknown>
  if (typeof value.rootId !== 'string' || !value.rootId || value.rootId.length > 512
    || typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 512
    || !Number.isSafeInteger(value.seq) || (value.seq as number) < 0) throw new TypeError('Invalid execution address')
  signal.throwIfAborted()
  let parentId: string | undefined
  if (value.sessionId !== value.rootId) {
    const descendants = await reads.descendants(SessionId(value.rootId), signal)
    const entry = descendants?.find(item => item.id === value.sessionId && item.kind !== 'diagnostic')
    if (!entry) throw new Error('Execution session is not in the selected catalog')
    parentId = entry.parentId
  }
  const inspected = await reads.inspect(SessionId(value.sessionId), signal)
  signal.throwIfAborted()
  if (!inspected || inspected.meta.id !== value.sessionId || (parentId !== undefined
    && (inspected.meta.origin !== 'subagent' || inspected.meta.parentSession !== parentId))) throw new Error('Execution session unavailable')
  const events = inspected.events.slice(inspected.inheritedEventCount)
  const event = events.find(item => item.seq === value.seq)
  if (!event) throw new Error('Execution event unavailable')
  let input = ''
  let output = ''
  if (event.type === 'subagent/catalog' || event.type === 'tool-workflow/agent-start') {
    const childId = event.data.childId
    const descendants = await reads.descendants(SessionId(value.sessionId), signal)
    if (!descendants?.some(row => row.id === childId && row.parentId === value.sessionId && row.kind !== 'diagnostic')) throw new Error('Dispatch child unavailable')
    const child = await reads.inspect(childId, signal)
    signal.throwIfAborted()
    if (!child || child.meta.origin !== 'subagent' || child.meta.parentSession !== value.sessionId || child.meta.id !== childId) throw new Error('Dispatch child unavailable')
    const prompt = child.events.slice(child.inheritedEventCount).find(item => item.type === 'user/message' && item.data.source.kind === 'user')
    if (prompt?.type === 'user/message') input = textContent(prompt.data.content)
  } else if (event.type === 'team/message/queued' && event.data.version === 2 && event.data.teamId === value.sessionId) {
    output = textContent(event.data.message.content)
  } else if (event.type === 'team/message/delivered' && event.data.version === 2 && event.data.teamId === value.sessionId) {
    const queued = events.find(item => item.type === 'team/message/queued' && item.data.version === 2 && item.data.teamId === event.data.teamId
      && item.data.message.id === event.data.messageId && item.data.message.targetId === event.data.targetId)
    if (queued?.type === 'team/message/queued') output = textContent(queued.data.message.content)
  } else if (event.type === 'user/message' && (event.data.source.kind === 'agent-message' || event.data.source.kind === 'subagent-settled')) {
    output = textContent(event.data.content)
  } else if (event.type === 'tool/call') {
    input = argumentsText(event.data.arguments)
    const result = events.find((item): item is Extract<SessionEvent, { type: 'tool/result' }> => item.type === 'tool/result'
      && item.data.turn === event.data.turn && item.data.step === event.data.step && item.data.message.content[0].toolCallId === event.data.callId)
    if (result) output = textContent(result.data.message.content[0].content)
  } else if (event.type === 'step/start' || event.type === 'turn/start') {
    const start = events.indexOf(event)
    const subsequent = events.slice(start + 1)
    const end = subsequent.findIndex(item => item.type === 'turn/end' && item.data.turn === event.data.turn
      || event.type === 'step/start' && item.type === 'step/end' && item.data.turn === event.data.turn && item.data.step === event.data.step)
    const own = end < 0 ? subsequent : subsequent.slice(0, end)
    input = own.flatMap(item => item.type === 'user/message' && item.data.source.kind === 'user' ? [textContent(item.data.content)] : []).join('\n')
    output = own.filter(item => item.type === 'assistant/message').map(item => textContent(item.data.message.content)).join('\n')
  }
  input = redact(input); output = redact(output)
  return { protocol: MONITOR_PROTOCOL, sessionId: value.sessionId, seq: value.seq as number,
    input: input.slice(0, LIMIT), output: output.slice(0, LIMIT), truncated: input.length > LIMIT || output.length > LIMIT }
}
