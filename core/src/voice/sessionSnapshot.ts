import { DHOutputMessage } from '../types'

const audioInputErrorCodes = ['unavailable', 'permission_denied', 'device_lost', 'format_mismatch', 'initialization_failed'] as const
export type AudioInputErrorCode = typeof audioInputErrorCodes[number]

const wakeHintCodes = ['wake_event_not_observed', 'wake_publisher_unavailable'] as const
export type WakeHintCode = typeof wakeHintCodes[number]

export type ServiceState = { status: 'connecting' | 'ready' }
  | { status: 'unavailable'; reason: 'service_fault' | 'local_network' | 'unknown' }

/** The latest validated client snapshot; opaque epochs scope revisions to one execution. */
export type VoiceSessionSnapshot = Readonly<{
  type: 'session.snapshot',
  session_id: string,
  state_epoch: string,
  revision: number,
  state: Readonly<{
    conversation: Readonly<{
      state: 'ended' | 'voice' | 'text',
      phase: 'idle' | 'starting' | 'waiting_playback' | 'capturing' | 'responding' | 'stopping',
    }>,
    audio_input: Readonly<{
      source: 'frontend' | 'xunfei' | null,
      status: 'unavailable' | 'preparing' | 'ready' | 'capturing' | 'error',
      source_revision: number,
      capture_turn_id: string | null,
      error_code?: AudioInputErrorCode,
      wake_hint?: WakeHintCode,
    }>,
    service?: Readonly<ServiceState>,
  }>,
}>

type SnapshotListener = (value: VoiceSessionSnapshot | undefined) => void

/** Snapshot observers cannot interrupt protocol handling or session cleanup. */
export function createSnapshotObservation() {
  let value: VoiceSessionSnapshot | undefined
  const listeners = new Set<SnapshotListener>()
  const notify = (listener: SnapshotListener) => {
    try { listener(value) } catch { /* consumer exceptions must not affect the session */ }
  }
  const unsubscribe = (listener?: SnapshotListener) => {
    if (listener) listeners.delete(listener)
    else listeners.clear()
  }
  return {
    get value() { return value },
    publish(next: VoiceSessionSnapshot | undefined) {
      if (next === value) return
      value = next
      for (const listener of [...listeners]) {
        if (value !== next) break // A listener may close the session while being notified.
        if (listeners.has(listener)) notify(listener)
      }
    },
    subscribe(listener: SnapshotListener) {
      listeners.add(listener)
      notify(listener)
      return () => unsubscribe(listener)
    },
    unsubscribe,
  }
}

function serviceState(value: any): ServiceState | undefined {
  if (!value || typeof value !== 'object') return
  if (value.status === 'unavailable') {
    if (Object.keys(value).length === 2 && ['service_fault', 'local_network', 'unknown'].includes(value.reason)) {
      return { status: value.status, reason: value.reason }
    }
  } else if (Object.keys(value).length === 1 && (value.status === 'ready' || value.status === 'connecting')) {
    return { status: value.status }
  }
}

/** Full replacement projection only: never sends intents or microphone commands. */
export function createSessionSnapshotProjection(sessionId: string) {
  let epoch: string | undefined
  let revision = -1
  let latest: DHOutputMessage[] = []
  let current: VoiceSessionSnapshot | undefined
  let negotiated = false
  function acknowledge(expectedEpoch: string) {
    if (negotiated && epoch === expectedEpoch) return false
    negotiated = true
    epoch = expectedEpoch
    revision = -1
    current = undefined
    latest = []
    return true
  }
  function ingest(event: any): DHOutputMessage[] {
    if (event?.type !== 'session.snapshot' || event.session_id !== sessionId
        || typeof event.state_epoch !== 'string' || !event.state_epoch
        || !Number.isInteger(event.revision) || event.revision < 0
        || (epoch !== undefined && event.state_epoch !== epoch) || event.revision <= revision) return []
    const conversation = event.state?.conversation
    const input = event.state?.audio_input
    if (!conversation || !input || !['ended', 'voice', 'text'].includes(conversation.state)
        || !['idle', 'starting', 'waiting_playback', 'capturing', 'responding', 'stopping'].includes(conversation.phase)
        || ![null, 'frontend', 'xunfei'].includes(input.source)
        || !['unavailable', 'preparing', 'ready', 'capturing', 'error'].includes(input.status)
        || !Number.isInteger(input.source_revision) || input.source_revision < 0
        || (input.status === 'capturing') !== (conversation.phase === 'capturing')
        || (input.status === 'capturing' && conversation.state !== 'voice')
        || (input.source === null && !['unavailable', 'error'].includes(input.status))
        || (input.error_code !== undefined && (input.status !== 'error'
          || !audioInputErrorCodes.includes(input.error_code)))
        || (input.status === 'capturing'
          ? typeof input.capture_turn_id !== 'string' || !input.capture_turn_id || input.source === null
          : input.capture_turn_id !== null)) return []
    const observed = negotiated ? serviceState(event.state.service) : undefined
    if (negotiated ? !observed : Object.prototype.hasOwnProperty.call(event.state, 'service')) return []
    const wakeHint = input.source === 'xunfei' && wakeHintCodes.includes(input.wake_hint) ? input.wake_hint : undefined
    epoch = event.state_epoch
    revision = event.revision
    current = Object.freeze({
      type: 'session.snapshot', session_id: sessionId, state_epoch: event.state_epoch, revision,
      state: Object.freeze({
        conversation: Object.freeze({ state: conversation.state, phase: conversation.phase }),
        audio_input: Object.freeze({
          source: input.source, status: input.status, source_revision: input.source_revision,
          capture_turn_id: input.capture_turn_id,
          ...(input.error_code !== undefined ? { error_code: input.error_code } : {}),
          ...(wakeHint !== undefined ? { wake_hint: wakeHint } : {}),
        }),
        ...(observed ? { service: Object.freeze(observed) } : {}),
      }),
    })
    const status = conversation.state === 'ended' ? 'sleeping'
      : input.status === 'capturing' ? 'listening'
      : ['responding', 'waiting_playback'].includes(conversation.phase) ? 'talking' : 'sleeping'
    latest = [{ type: 'status_change', status }]
    return latest.map(message => ({ ...message }))
  }
  return { ingest, acknowledge, negotiated: () => negotiated, snapshot: () => current,
    service: () => current?.state.service,
    inputError: () => current?.state.audio_input.status === 'error'
      ? current.state.audio_input.error_code ?? 'unavailable' : undefined,
    replay: () => latest.map(message => ({ ...message })) }
}
