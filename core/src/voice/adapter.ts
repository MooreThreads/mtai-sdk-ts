import { DHOutputMessage, DHStatus } from "../types"

/**
 * Wire frames of the voice MVP frontend-to-client protocol that this SDK
 * consumes or produces. Field names match the client protocol exactly; only
 * the subset relevant to the SDK adapter is modeled, extra fields are allowed.
 */

/** Subtitle segment attached to an output `audio.chunk` control frame. */
export type VoiceSubtitleSegment = {
  source: "main" | "narrator",
  text: string,
}

/** Control frames the SDK sends to the voice client. */
export type VoiceClientFrame =
  | { type: 'session.start', session_id: string, protocol_version: number }
  | { type: 'conversation.start', session_id: string }
  | { type: 'conversation.stop', session_id: string }
  | { type: 'text.input', session_id: string, request_id: string, text: string }
  | { type: 'audio.chunk', direction: 'input', session_id: string, turn_id: string, byte_count: number }
  | { type: 'playback.ended', session_id: string, turn_id: string }

/** Control frames the voice client sends to the SDK. */
export type VoiceClientEvent = {
  type: string,
  session_id?: string,
  turn_id?: string,
  text?: string,
  state?: string,
  subtitles?: VoiceSubtitleSegment[],
  [key: string]: any,
}

/** A microphone PCM batch: the control frame is immediately followed by its binary payload. */
export type VoiceAudioInput = {
  control: Extract<VoiceClientFrame, { type: 'audio.chunk' }>,
  binary: Uint8Array,
}

export type VoiceMessageAdapterOptions = {
  /** The voice session identity this adapter owns. */
  sessionId: string,
  /** Adapter-originated sends (for example the deferred wakeup start). */
  onClientSend?: (_: VoiceClientFrame) => void,
  /** Generates typed-input correlation handles. */
  requestIdFactory?: () => string,
}

const PROTOCOL_VERSION = 2

function defaultRequestIdFactory() {
  const cryptoApi = (globalThis as any).crypto
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return () => cryptoApi.randomUUID() as string
  }
  return () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

/**
 * Adapts between the frontend-to-client voice protocol and the SDK's existing
 * app-facing message surface (`asr_process`, `bot_output`, `audio_text`,
 * `message_record`, `status_change`).
 *
 * The adapter keeps per-session and per-turn state: accumulated `bot_output`
 * fragments keyed by `session_id + turn_id`, the current conversation state,
 * the accepted capture turn, and any pending wakeup stop-then-start sequence.
 * Turns are fenced at `turn.end`: duplicate terminal events never produce
 * duplicate records, and late `assistant.text` fragments or `audio.chunk`
 * subtitles from a retired turn are dropped before they can reach the app.
 * `reset()` fences a new connection generation so fragments are never
 * combined across reconnects.
 */
export function createVoiceMessageAdapter(options: VoiceMessageAdapterOptions) {
  const { sessionId } = options
  const onClientSend = options.onClientSend
  const newRequestId = options.requestIdFactory ?? defaultRequestIdFactory()

  let conversationEnded = true
  let captureTurnId: string | undefined = undefined
  let pendingWakeupStart = false
  /** Accumulated bot_output fragments per `session_id + turn_id`. */
  const fragments = new Map<string, string[]>()
  /** Turns that already emitted their derived message_record. */
  const finalizedTurns = new Set<string>()

  const turnKey = (turnId: unknown) => `${sessionId}\u0000${turnId}`

  function statusMessage(status: (typeof DHStatus)[number]): DHOutputMessage {
    return { type: 'status_change', status }
  }

  function ingest(event: VoiceClientEvent): DHOutputMessage[] {
    if (event == null || typeof event.type !== 'string') {
      return []
    }
    switch (event.type) {
      case 'asr.partial':
      case 'asr.final': {
        if (event.session_id !== sessionId) return []
        const text = typeof event.text === 'string' ? event.text : ''
        return [{ type: 'asr_process', sentence: text, completed: event.type === 'asr.final' }]
      }
      case 'assistant.text': {
        if (event.session_id !== sessionId || typeof event.turn_id !== 'string') return []
        const key = turnKey(event.turn_id)
        if (finalizedTurns.has(key)) {
          // The turn is retired; a late fragment must never reach the app.
          return []
        }
        const text = typeof event.text === 'string' ? event.text : ''
        fragments.set(key, [...(fragments.get(key) || []), text])
        return [{ type: 'bot_output', text }]
      }
      case 'audio.chunk': {
        if (event.session_id !== sessionId) return []
        if (typeof event.turn_id === 'string' && finalizedTurns.has(turnKey(event.turn_id))) {
          // The turn is retired; late subtitles must never reach the app.
          return []
        }
        const subtitles = Array.isArray(event.subtitles) ? event.subtitles : []
        return subtitles
          .filter(segment => segment && (segment.source === 'main' || segment.source === 'narrator')
            && typeof segment.text === 'string')
          .map(segment => ({ type: 'audio_text', text: segment.text }) as DHOutputMessage)
      }
      case 'turn.end': {
        if (event.session_id !== sessionId || typeof event.turn_id !== 'string') return []
        const key = turnKey(event.turn_id)
        if (finalizedTurns.has(key)) {
          return []
        }
        finalizedTurns.add(key)
        const joined = (fragments.get(key) || []).join('')
        fragments.delete(key)
        if (!joined) {
          return []
        }
        return [{ type: 'message_record', message: { role: 'assistant', content: joined } }]
      }
      case 'capture.start': {
        if (event.session_id !== sessionId) return []
        if (typeof event.turn_id === 'string' && event.turn_id) {
          captureTurnId = event.turn_id
        }
        return [statusMessage('listening')]
      }
      case 'capture.stop': {
        if (event.session_id !== sessionId) return []
        if (captureTurnId === event.turn_id) {
          captureTurnId = undefined
        }
        if (conversationEnded) {
          return []
        }
        return [statusMessage('talking')]
      }
      case 'conversation.state': {
        if (event.session_id !== sessionId) return []
        const ended = event.state === 'ended'
        conversationEnded = ended
        if (ended) {
          captureTurnId = undefined
          if (pendingWakeupStart) {
            pendingWakeupStart = false
            onClientSend?.({ type: 'conversation.start', session_id: sessionId })
          }
          return [statusMessage('sleeping')]
        }
        return []
      }
      default:
        // session.state, text.accepted, dh_2d_session_ready, playback.stop,
        // diagnostics and unknown events carry no app-facing message.
        return []
    }
  }

  function startFrame(): VoiceClientFrame {
    return { type: 'session.start', session_id: sessionId, protocol_version: PROTOCOL_VERSION }
  }

  function wakeup(): VoiceClientFrame[] {
    if (conversationEnded && !pendingWakeupStart) {
      return [{ type: 'conversation.start', session_id: sessionId }]
    }
    pendingWakeupStart = true
    return [{ type: 'conversation.stop', session_id: sessionId }]
  }

  function sleep(): VoiceClientFrame[] {
    pendingWakeupStart = false
    return [{ type: 'conversation.stop', session_id: sessionId }]
  }

  function textInput(text: string): VoiceClientFrame {
    return { type: 'text.input', session_id: sessionId, request_id: newRequestId(), text }
  }

  function audioInput(bytes: Uint8Array): VoiceAudioInput | null {
    if (!captureTurnId) {
      return null
    }
    return {
      control: {
        type: 'audio.chunk', direction: 'input',
        session_id: sessionId, turn_id: captureTurnId, byte_count: bytes.byteLength,
      },
      binary: bytes,
    }
  }

  function playbackEnded(turnId: string): VoiceClientFrame {
    return { type: 'playback.ended', session_id: sessionId, turn_id: turnId }
  }

  function reset() {
    conversationEnded = true
    captureTurnId = undefined
    pendingWakeupStart = false
    fragments.clear()
    finalizedTurns.clear()
  }

  return {
    /** The voice session identity owned by this adapter. */
    sessionId,
    ingest,
    startFrame,
    wakeup,
    sleep,
    textInput,
    audioInput,
    playbackEnded,
    reset,
  }
}

export type VoiceMessageAdapter = ReturnType<typeof createVoiceMessageAdapter>
