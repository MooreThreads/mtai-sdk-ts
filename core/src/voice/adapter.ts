import { DHOutputMessage, DHStatus } from "../types"

/**
 * Wire frames of the voice MVP frontend-to-client protocol that this SDK
 * consumes or produces. Field names match the client protocol exactly; only
 * the subset relevant to the SDK adapter is modeled, extra fields are allowed.
 */

/** Subtitle segment attached to an output `audio.output.delta` control frame. */
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
  | { type: 'audio.input.delta', direction: 'input', session_id: string, turn_id: string, byte_count: number }
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
  control: Extract<VoiceClientFrame, { type: 'audio.input.delta' }>,
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
 * fragments keyed by `session_id + turn_id` (emitted as replacement text),
 * incremental audio subtitles, confirmed user records, the current conversation state,
 * the accepted capture turn, and any pending wakeup stop-then-start sequence.
 * Statuses transform strictly: `capture.start` reports `listening`, and
 * `capture.stop` or the acknowledgement of the current generation's typed
 * input (`text.accepted`) reports `talking`; only `conversation.state:ended`
 * reports `sleeping`. No other event invents or changes a status —
 * `text.output.delta`/`audio.output.*` frames, `turn.end`, and non-ended
 * `conversation.state` modes preserve the current active status — and
 * `sleep_talking` is never emitted.
 * Turns are fenced at `turn.end`: duplicate terminal events never produce
 * duplicate records, and late `text.output.delta` fragments, `audio.output.delta`
 * subtitles, ASR events, or `capture.start`/`capture.stop` controls from a
 * retired turn are dropped before they can reach the app or replace the
 * accepted capture turn. `reset()` fences a new connection generation so
 * fragments are never combined across reconnects.
 *
 * Pending-message sequencing is session-scoped and fenced by a monotonic
 * generation: every new wakeup, input, or sleep action retires the previous
 * sequence so its deferred frames can never send. `wakeup(text)` sends
 * `conversation.start` then `text.input` immediately; `sleep(text)` sends
 * `text.input` and defers `conversation.stop` until the avatar played the
 * accepted turn (correlated through `text.accepted`) and then moved on to a
 * different validated turn (reported through `observeAvatarTurn`).
 */
export function createVoiceMessageAdapter(options: VoiceMessageAdapterOptions) {
  const { sessionId } = options
  const onClientSend = options.onClientSend
  const newRequestId = options.requestIdFactory ?? defaultRequestIdFactory()

  let conversationEnded = true
  let captureTurnId: string | undefined = undefined
  let pendingWakeupStart = false
  /** Generation captured when the pending wakeup start was armed. */
  let pendingWakeupStartGeneration = 0
  /**
   * Monotonic generation of the session-scoped pending-message sequence.
   * Every new wakeup, input, or sleep action — and every reset — retires the
   * previous sequence; deferred sends capture the generation and recheck it
   * before sending so an interrupted sequence can never emit a frame.
   */
  let pendingMessageGeneration = 0
  /**
   * The single session-scoped pending sleep-with-text sequence:
   * `text.input` was sent and `conversation.stop` is deferred until the
   * avatar has played the accepted turn and then moved on to a different
   * validated turn (see `observeAvatarTurn`).
   */
  let pendingSleepStop: {
    generation: number,
    requestId: string,
    acceptedTurnId: string | undefined,
    observedAcceptedTurn: boolean,
  } | undefined = undefined
  /** Accumulated bot_output fragments per `session_id + turn_id`. */
  const fragments = new Map<string, string[]>()
  /** Turns that already emitted their derived message_record. */
  const finalizedTurns = new Set<string>()
  /** ASR finals already confirmed as user records in this connection. */
  const confirmedAsrTurns = new Set<string>()
  let typedText: string | undefined
  /**
   * Request id of the current generation's typed input, if any. A
   * `text.accepted` acknowledgement for exactly this request — while its
   * generation is still current, its turn id is present, and the turn is
   * not retired — reports the accepted typed turn as `talking`, once per
   * request. Acknowledgements for other sessions, unknown or retired
   * requests, or retired turns never report a status.
   */
  let typedRequestId: string | undefined = undefined

  const turnKey = (turnId: unknown) => `${sessionId}\u0000${turnId}`

  /** True when the event names a turn that already saw `turn.end`. */
  const isRetiredTurn = (event: VoiceClientEvent) => (
    typeof event.turn_id === 'string'
    && !!event.turn_id
    && finalizedTurns.has(turnKey(event.turn_id))
  )

  function statusMessage(status: (typeof DHStatus)[number]): DHOutputMessage {
    return { type: 'status_change', status }
  }

  /** Normalized user text: a non-blank string, or undefined. */
  function messageText(text: unknown): string | undefined {
    return typeof text === 'string' && text.trim() ? text : undefined
  }

  /**
   * Retires the session-scoped pending-message sequence explicitly.
   * Callers that translate an SDK action into adapter calls must invalidate
   * before their own validation (for example an input whose text turns out
   * blank, or an input rejected for `bot_text`), so every SDK input action
   * retires the previous sequence even when no frame follows. The adapter
   * actions also invalidate internally, so an extra call is harmless.
   */
  function invalidatePendingSequence() {
    pendingMessageGeneration++
    pendingWakeupStart = false
    pendingSleepStop = undefined
    typedRequestId = undefined
    typedText = undefined
  }

  /** Sends a deferred frame only while its generation is still current. */
  function sendDeferred(generation: number, frame: VoiceClientFrame) {
    if (generation !== pendingMessageGeneration) {
      return
    }
    onClientSend?.(frame)
  }

  function ingest(event: VoiceClientEvent): DHOutputMessage[] {
    if (event == null || typeof event.type !== 'string') {
      return []
    }
    switch (event.type) {
      case 'command':
        // The connection owns the destination; command fields are opaque.
        // No action schema, voice-state mutation or execution acknowledgement.
        return [event as DHOutputMessage]
      case 'asr.partial':
      case 'asr.final': {
        if (event.session_id !== sessionId) return []
        if (isRetiredTurn(event)) {
          // The turn is retired; late ASR must never reach the app.
          return []
        }
        const key = typeof event.turn_id === 'string' && event.turn_id ? turnKey(event.turn_id) : undefined
        if (key && confirmedAsrTurns.has(key)) return []
        const text = typeof event.text === 'string' ? event.text : ''
        const completed = event.type === 'asr.final'
        const messages: DHOutputMessage[] = [{ type: 'asr_process', sentence: text, completed }]
        if (completed) {
          if (key) confirmedAsrTurns.add(key)
          // Wakeup ASR is already submitted by the voice service. An
          // asr_session final would cause legacy clients to submit it again.
          if (text.trim()) messages.push({ type: 'message_record', message: { role: 'user', content: text } })
        }
        return messages
      }
      case 'text.output.delta': {
        if (event.session_id !== sessionId || typeof event.turn_id !== 'string') return []
        const key = turnKey(event.turn_id)
        if (finalizedTurns.has(key)) {
          // The turn is retired; a late fragment must never reach the app.
          return []
        }
        const text = typeof event.text === 'string' ? event.text : ''
        fragments.set(key, [...(fragments.get(key) || []), text])
        return [{ type: 'bot_output', text: fragments.get(key)!.join('') }]
      }
      case 'audio.output.delta': {
        if (event.session_id !== sessionId) return []
        if (typeof event.turn_id === 'string' && finalizedTurns.has(turnKey(event.turn_id))) {
          // The turn is retired; late subtitles must never reach the app.
          return []
        }
        const subtitles = Array.isArray(event.subtitles) ? event.subtitles : []
        return subtitles
          .filter(segment => segment && (segment.source === 'main' || segment.source === 'narrator')
            && typeof segment.text === 'string')
          .map(segment => ({ type: 'audio_text', text: segment.text } as DHOutputMessage))
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
        if (isRetiredTurn(event)) {
          // The turn is retired; a late capture.start must neither replace
          // the accepted capture turn nor emit a listening status.
          return []
        }
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
        if (isRetiredTurn(event)) {
          // The turn is retired; release the matching capture turn above but
          // never emit a talking status for it.
          return []
        }
        if (conversationEnded) {
          return []
        }
        return [statusMessage('talking')]
      }
      case 'text.accepted': {
        if (event.session_id !== sessionId) return []
        // Correlates the accepted turn for the pending sleep-with-text
        // sequence. Internal only: no app-facing message is derived from
        // `text.accepted` for the sleep sequencing itself, and
        // acknowledgements for another session, an unknown request id, or a
        // retired generation never arm the sequence. A duplicate
        // acknowledgement keeps the first turn.
        if (
          pendingSleepStop !== undefined
          && pendingSleepStop.generation === pendingMessageGeneration
          && pendingSleepStop.acceptedTurnId === undefined
          && event.request_id === pendingSleepStop.requestId
          && typeof event.turn_id === 'string'
          && event.turn_id
        ) {
          pendingSleepStop.acceptedTurnId = event.turn_id
        }
        // The acknowledgement of the current typed input reports the
        // accepted typed turn as a user record followed by `talking` — once
        // per request. Wrong
        // sessions, unknown or retired requests, missing turn ids, retired
        // turns, and duplicates never report a status.
        if (
          typedRequestId !== undefined
          && event.request_id === typedRequestId
          && typeof event.turn_id === 'string'
          && !!event.turn_id
          && !isRetiredTurn(event)
        ) {
          const text = typedText
          typedRequestId = undefined
          typedText = undefined
          const messages: DHOutputMessage[] = []
          if (text?.trim()) messages.push({ type: 'message_record', message: { role: 'user', content: text } })
          messages.push(statusMessage('talking'))
          return messages
        }
        return []
      }
      case 'conversation.state': {
        if (event.session_id !== sessionId) return []
        const ended = event.state === 'ended'
        conversationEnded = ended
        if (ended) {
          captureTurnId = undefined
          if (pendingWakeupStart) {
            const generation = pendingWakeupStartGeneration
            pendingWakeupStart = false
            sendDeferred(generation, { type: 'conversation.start', session_id: sessionId })
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

  function wakeup(text?: string): VoiceClientFrame[] {
    invalidatePendingSequence()
    const userText = messageText(text)
    if (userText !== undefined) {
      // Text-bearing wakeup always opens the conversation immediately:
      // `conversation.start` is idempotent while a conversation is already
      // active, so the text is never held behind a stop-then-start sequence.
      const requestId = newRequestId()
      typedRequestId = requestId
      typedText = userText
      return [
        { type: 'conversation.start', session_id: sessionId },
        { type: 'text.input', session_id: sessionId, request_id: requestId, text: userText },
      ]
    }
    if (conversationEnded && !pendingWakeupStart) {
      return [{ type: 'conversation.start', session_id: sessionId }]
    }
    pendingWakeupStart = true
    pendingWakeupStartGeneration = pendingMessageGeneration
    return [{ type: 'conversation.stop', session_id: sessionId }]
  }

  function sleep(text?: string): VoiceClientFrame[] {
    invalidatePendingSequence()
    const userText = messageText(text)
    if (userText !== undefined) {
      // Text-bearing sleep sends only the text; `conversation.stop` is
      // deferred until the avatar played the accepted turn out (see
      // `observeAvatarTurn`).
      const requestId = newRequestId()
      typedRequestId = requestId
      typedText = userText
      pendingSleepStop = {
        generation: pendingMessageGeneration,
        requestId,
        acceptedTurnId: undefined,
        observedAcceptedTurn: false,
      }
      return [{ type: 'text.input', session_id: sessionId, request_id: requestId, text: userText }]
    }
    return [{ type: 'conversation.stop', session_id: sessionId }]
  }

  function textInput(text: string): VoiceClientFrame {
    invalidatePendingSequence()
    const requestId = newRequestId()
    typedRequestId = requestId
    typedText = text
    return { type: 'text.input', session_id: sessionId, request_id: requestId, text }
  }

  /**
   * Maps an SDK `asr_session` control to the client conversation lifecycle
   * that owns listening: `start` opens listening (`conversation.start`, the
   * client ignores it while already listening) and never cancels pending
   * sequencing; `stop` ends listening (`conversation.stop`) and, acting
   * exactly like a text-less sleep, retires the pending sequence.
   */
  function asrSession(command: 'start' | 'stop'): VoiceClientFrame[] {
    if (command === 'stop') {
      invalidatePendingSequence()
      return [{ type: 'conversation.stop', session_id: sessionId }]
    }
    return [{ type: 'conversation.start', session_id: sessionId }]
  }

  function audioInput(bytes: Uint8Array): VoiceAudioInput | null {
    if (!captureTurnId) {
      return null
    }
    return {
      control: {
        type: 'audio.input.delta', direction: 'input',
        session_id: sessionId, turn_id: captureTurnId, byte_count: bytes.byteLength,
      },
      binary: bytes,
    }
  }

  function playbackEnded(turnId: string): VoiceClientFrame {
    return { type: 'playback.ended', session_id: sessionId, turn_id: turnId }
  }

  /**
   * Reports a validated avatar turn observation (from the DH2D turn stripe)
   * to the pending sleep-with-text sequence. The deferred `conversation.stop`
   * fires only after the accepted turn itself has been observed in avatar
   * playback and a later, different validated turn follows it; observations
   * that arrive before the acknowledgement, and invalid or missing frames
   * (which the playback bridge never reports), never count as the
   * transition. No timeout or synthetic transition is ever fabricated.
   */
  function observeAvatarTurn(turnId: string) {
    if (!turnId || pendingSleepStop === undefined) {
      return
    }
    if (pendingSleepStop.generation !== pendingMessageGeneration) {
      return
    }
    const acceptedTurnId = pendingSleepStop.acceptedTurnId
    if (acceptedTurnId === undefined) {
      return
    }
    if (!pendingSleepStop.observedAcceptedTurn) {
      if (turnId === acceptedTurnId) {
        pendingSleepStop.observedAcceptedTurn = true
      }
      return
    }
    if (turnId !== acceptedTurnId) {
      const generation = pendingSleepStop.generation
      pendingSleepStop = undefined
      sendDeferred(generation, { type: 'conversation.stop', session_id: sessionId })
    }
  }

  function reset() {
    invalidatePendingSequence()
    conversationEnded = true
    captureTurnId = undefined
    fragments.clear()
    confirmedAsrTurns.clear()
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
    asrSession,
    audioInput,
    playbackEnded,
    observeAvatarTurn,
    reset,
    invalidatePendingSequence,
  }
}

export type VoiceMessageAdapter = ReturnType<typeof createVoiceMessageAdapter>
