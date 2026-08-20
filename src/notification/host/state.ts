/** Fold live Session events into the three desktop-pet states. */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { PetOutcome, PetState } from '../shared.js'

interface SessionActivity {
  running: boolean
  approvals: Set<string>
  questions: Set<string>
  topLevel: boolean
}

const HUMAN_INTERACTION_TOOLS = new Set(['ask_user_question', 'exit_plan_mode'])
const BLOCKED_END_REASONS = new Set(['blocked', 'error', 'max-tokens', 'interrupted'])

export interface NotificationTransition {
  state: PetState
  /** A fresh human-interaction wait was committed. */
  confirmation: boolean
  /** A top-level turn completed successfully. */
  completion: boolean
  /** A short-lived top-level completion or blocked reaction. */
  outcome: PetOutcome | undefined
}

function activityOf(session: Session): SessionActivity {
  return {
    running: false,
    approvals: new Set(),
    questions: new Set(),
    topLevel: session.header.origin !== 'subagent',
  }
}

function stringField(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' && field.length > 0 ? field : undefined
}

function resultCallId(data: unknown): string | undefined {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  const message = (data as Record<string, unknown>)['message']
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return undefined
  return stringField((message as Record<string, unknown>)['source'], 'callId')
}

/** Tracks all live sessions so concurrent tasks project one global pet state. */
export class NotificationStateTracker {
  private readonly sessions = new Map<string, SessionActivity>()

  /** Seed state from sessions that existed before this plugin loaded, without replaying sounds. */
  initialize(sessions: readonly Session[]): PetState {
    this.sessions.clear()
    for (const session of sessions) {
      const activity = activityOf(session)
      this.sessions.set(session.id, activity)
      for (const event of session.events) this.apply(activity, event, false)
    }
    return this.current()
  }

  /** Consume one post-commit event and report its global state and one-shot notifications. */
  consume(session: Session, event: SessionEvent): NotificationTransition {
    let activity = this.sessions.get(session.id)
    if (activity === undefined) {
      activity = activityOf(session)
      this.sessions.set(session.id, activity)
    }
    const signal = this.apply(activity, event, true)
    return { state: this.current(), ...signal }
  }

  /** Remove a disposed session from the global fold. */
  remove(session: Session): PetState {
    this.sessions.delete(session.id)
    return this.current()
  }

  /** Current priority: confirmation, then working, then idle. */
  current(): PetState {
    for (const activity of this.sessions.values()) {
      if (activity.approvals.size > 0 || activity.questions.size > 0) return 'confirmation'
    }
    for (const activity of this.sessions.values()) {
      if (activity.running) return 'working'
    }
    return 'idle'
  }

  private apply(
    activity: SessionActivity,
    event: SessionEvent,
    announce: boolean,
  ): Pick<NotificationTransition, 'confirmation' | 'completion' | 'outcome'> {
    let confirmation = false
    let completion = false
    let outcome: PetOutcome | undefined
    const type = event.type as string

    switch (type) {
      case 'turn/start':
        activity.running = true
        break
      case 'turn/end': {
        activity.running = false
        activity.approvals.clear()
        activity.questions.clear()
        const reason = event.data !== null && typeof event.data === 'object'
          ? (event.data as { reason?: { kind?: unknown } }).reason
          : undefined
        if (announce && activity.topLevel && reason?.kind === 'completed') {
          completion = true
          outcome = 'ready'
        } else if (
          announce
          && activity.topLevel
          && typeof reason?.kind === 'string'
          && BLOCKED_END_REASONS.has(reason.kind)
        ) {
          outcome = 'blocked'
        }
        break
      }
      case 'approval/asked': {
        const id = stringField(event.data, 'id')
        if (id !== undefined) {
          activity.approvals.add(id)
          confirmation = announce
        }
        break
      }
      case 'approval/decided': {
        const id = stringField(event.data, 'id')
        if (id !== undefined) activity.approvals.delete(id)
        break
      }
      case 'tool/call': {
        const name = stringField(event.data, 'name')
        const callId = stringField(event.data, 'callId')
        if (name !== undefined && HUMAN_INTERACTION_TOOLS.has(name) && callId !== undefined) {
          activity.questions.add(callId)
          confirmation = announce
        }
        break
      }
      case 'tool/result': {
        const callId = resultCallId(event.data)
        if (callId !== undefined) activity.questions.delete(callId)
        break
      }
    }

    return { confirmation, completion, outcome }
  }
}
