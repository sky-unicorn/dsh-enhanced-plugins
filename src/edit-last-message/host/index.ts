import type { Context } from '@deepseek-ai/cordis'
import { EditLastMessageRemote } from './remote.js'

export const name = 'edit-last-message-host'
export const inject = ['agents']

/** Install the same-session edit Remote without changing DSH core. */
export function apply(ctx: Context): void {
  new EditLastMessageRemote(ctx)
}

export { EditLastMessageRemote } from './remote.js'
export { rewriteLastMessage } from './rewind.js'
export type { EditLastMessageHostRequest, EditLastMessageHostResult } from './rewind.js'
