/** Task sounds and native desktop-pet Host plugin. */

import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { NotificationSettings } from '../shared.js'
import { Config, SETTINGS_NAMESPACE } from './config.js'
import { DesktopCompanion } from './desktop.js'
import { NotificationConfigRemote } from './remote.js'
import { NotificationStateTracker } from './state.js'

export { Config, SETTINGS_NAMESPACE } from './config.js'
export { DesktopCompanion } from './desktop.js'
export { NotificationConfigRemote } from './remote.js'
export {
  PetPositionStore,
  parsePetPositionEvent,
  type PetDisplayPlacement,
  type PetPlacementState,
  type PetPositionEvent,
} from './position-store.js'
export { CustomSoundLibrary } from './sound-library.js'
export { NotificationStateTracker, type NotificationTransition } from './state.js'
export type {
  NotificationSettings, NotificationSound, PetCharacter, PetOutcome, PetPosition, PetSize, PetState,
} from '../shared.js'

export const name = 'desktop-notifications'
export const inject = ['sessions', 'subprocess']

/** Mount the session observer, optional settings owner, and managed desktop companion. */
export function apply(ctx: Context, config: NotificationSettings): void {
  let current = (): NotificationSettings => config
  const tracker = new NotificationStateTracker()
  const companion = new DesktopCompanion(ctx, config)

  installSettingsSection(ctx, SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => { current = source },
    onChange: () => { companion.configure(current()) },
  })

  // The standard Host settings RPC deliberately hides third-party namespaces.
  // Mount a plugin-owned, revision-fenced Remote exactly while settings exists.
  ctx.inject(['settings'], (settingsContext) => {
    new NotificationConfigRemote(settingsContext, companion)
  })

  ctx.effect(() => {
    companion.configure(current())
    companion.setState(tracker.initialize(ctx.sessions.list()))
    const disposeEvent = ctx.on('session/event', (session, event) => {
      const transition = tracker.consume(session, event)
      companion.setState(transition.state)
      if (transition.confirmation) companion.play('confirmation')
      if (transition.completion) companion.play('completion')
      if (transition.outcome === 'blocked') companion.play('blocked')
      if (transition.outcome !== undefined) companion.showOutcome(transition.outcome)
    })
    const disposeSession = ctx.on('session/disposed', (session) => {
      companion.setState(tracker.remove(session))
    })
    return async () => {
      disposeEvent()
      disposeSession()
      await companion.dispose()
    }
  }, 'desktop notifications lifecycle')
}
