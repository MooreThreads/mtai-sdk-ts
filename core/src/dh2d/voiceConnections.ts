import { withChild } from "../abortable"
import { config as rootConfig } from "../config"
import { events } from "../events"
import { hooks } from "../hooks"
import { connectPc } from "../pc"
import { Abortable, DHConnectionEventTypes, DHConnectionEvents, DHInputMessage, Diff, Logger } from "../types"
import { createVoiceMessageAdapter, PROTOCOL_VERSION, VoiceClientFrame, VoiceMessageAdapter } from "../voice/adapter"
import {
  createChannelBindingToolHandler,
  type VoiceClientToolCall,
  type VoiceClientToolHandler,
  type VoiceClientToolResult,
} from "../voice/channelBinding"
import { createVoiceMicrophone } from "../voice/microphone"
import { createVoiceInputControl } from '../voice/inputControl'
import { DH2DConnection, DH2DPlayerElements, ResolvedDH2DSessionConfig } from "./types"
import { avatarTimingNow, createAvatarPlayback, AvatarFrameContext } from "./avatarMedia"
import { createReceiverStats } from "./receiverStats"
import { createChannelBindingUI } from '../voice/channelBindingUI'
import { createMicrophoneErrorBadge, createServiceUnavailableBadge } from './serviceUnavailableBadge'
import { createSnapshotObservation, type VoiceSessionSnapshot } from '../voice/sessionSnapshot'

/**
 * A DH2D connection whose voice-protocol traffic is carried by the voice
 * client websocket. The client owns the native DH2D application session and
 * its command websocket; this connection owns only the direct WebRTC offer
 * exchange and the avatar media path, using the canonical DH2D session id the
 * client reports in `dh_2d_session_ready`.
 */
export type VoiceClientConnection = DH2DConnection & {
  /** The voice protocol adapter owning this connection's session identity. */
  readonly voice: VoiceMessageAdapter,
  /** Observe the accepted client snapshot and its invalidation on epoch change or shutdown. */
  readonly onSnapshot: (handler: (snapshot: VoiceSessionSnapshot | undefined) => void) => () => void,
  /** Submit text on the negotiated connection and await client admission. */
  readonly sendVoice?: (message: DHInputMessage) => Promise<void>,
  /** Connection failure, observed during setup and by the active session. */
  readonly failure: Promise<never>,
  /** Stops avatar playback observation. */
  readonly stopPlayback: () => void,
  /**
   * Fences this connection generation: detaches the client websocket
   * callbacks, stops the microphone pipeline, and clears the video source,
   * so traffic from a retired connection can never reach the app. Fencing is
   * synchronous; the returned completion joins owned asynchronous retirement.
   */
  readonly dispose: () => void | Promise<void>,
}

const MAIN_VOICE_SESSION_ID = 'avatar-channel-session'

export class VoiceProtocolError extends Error {}

function isFrontendToolCall(value: unknown): value is VoiceClientToolCall {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const message = value as Record<string, unknown>
  const arguments_ = message.arguments
  return message.type === 'tool.call'
    && typeof message.session_id === 'string' && message.session_id.length > 0
    && typeof message.turn_id === 'string' && message.turn_id.length > 0
    && typeof message.call_id === 'string' && message.call_id.length > 0
    && typeof message.name === 'string' && message.name.length > 0
    && arguments_ !== null && typeof arguments_ === 'object' && !Array.isArray(arguments_)
}

function isFrontendToolResult(value: unknown): value is VoiceClientToolResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  if (result.ok === true) {
    return result.result !== null && typeof result.result === 'object' && !Array.isArray(result.result)
  }
  if (result.ok === false) {
    const error = result.error
    return error !== null && typeof error === 'object' && !Array.isArray(error)
      && typeof (error as Record<string, unknown>).code === 'string'
      && typeof (error as Record<string, unknown>).message === 'string'
  }
  return false
}

function isSerializedFrontendToolResult(
  value: unknown,
  call: VoiceClientToolCall,
): value is Record<string, unknown> & VoiceClientToolResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const frame = value as Record<string, unknown>
  return frame.type === 'tool.result'
    && frame.session_id === call.session_id
    && frame.turn_id === call.turn_id
    && frame.call_id === call.call_id
    && isFrontendToolResult(frame)
}

const FRONTEND_TOOL_FAILURE: VoiceClientToolResult = {
  ok: false,
  error: { code: 'frontend_tool_failed', message: 'frontend tool failed' },
}

const SAFE_FRONTEND_ERROR_MESSAGES: Record<string, readonly string[]> = {
  invalid_arguments: ['invalid binding arguments', 'channel must be "wechat"'],
  invalid_request: ['WeChat binding request was invalid'],
  unknown_operation: ['WeChat binding operation is no longer available'],
  binding_unavailable: ['WeChat binding service unavailable'],
  frontend_tool_failed: ['frontend tool failed'],
}

function sanitizeFrontendToolResult(value: unknown): VoiceClientToolResult {
  if (!isFrontendToolResult(value)) return FRONTEND_TOOL_FAILURE
  if (value.ok) return { ok: true, result: value.result }

  const code = value.error.code
  const messages = SAFE_FRONTEND_ERROR_MESSAGES[code]
  if (!messages) return FRONTEND_TOOL_FAILURE
  const message = messages.includes(value.error.message) ? value.error.message : messages[0]
  return { ok: false, error: { code, message } }
}

function validateVoiceSessionId(sessionId: string): void {
  // WHATWG URL/WebSocket normalization treats even encoded dot-only IDs as
  // path navigation. Reject exactly these IDs before any connection/retry.
  if (sessionId === '.' || sessionId === '..') {
    throw new Error('voice client sessionId must not be "." or ".."')
  }
}

/**
 * Builds the frontend-to-client websocket URL: the avatar mode and selected
 * `video_id` are connection-query parameters, never protocol messages.
 */
export function voiceClientWebSocketUrl(base: string, videoId: string, sessionId: string): string {
  validateVoiceSessionId(sessionId)
  const url = new URL(base)
  if (url.protocol === 'https:') {
    url.protocol = 'wss:'
  } else if (url.protocol === 'http:') {
    url.protocol = 'ws:'
  }
  if (!url.pathname || url.pathname === '/') {
    url.pathname = '/ws'
  }
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${encodeURIComponent(sessionId)}`
  url.searchParams.set('mode', 'avatar')
  url.searchParams.set('video_id', videoId)
  return url.toString()
}

/**
 * Translates an SDK input message into voice client protocol frames on the
 * given open websocket.
 *
 * - `wakeup` performs the stop-then-start sequence through the adapter when a
 *   conversation is active; with `text` it instead sends `conversation.start`
   * followed immediately by `text.input` (`conversation.start` is idempotent
 *   while already active). `sleep` stops the conversation; with `text` the
 *   stop is deferred until the accepted turn's avatar playback finished (see
 *   the adapter's pending sleep sequencing).
 * - `input.text` maps to `text.input`, except exact `/clear` (after trimming)
 *   maps to an ordered `command` frame; every `input` action — including one
 *   whose text is blank or that is rejected — retires the pending sequence
 *   before anything else. `input.bot_text` has no bot-authored equivalent
 *   on the frontend-to-client hop (the protocol's `text.input` is
 *   strictly user text and its announcement path is client-internal), so it
 *   is rejected with an explicit error instead of being silently dropped or
 *   misrouted as user text.
 * - `asr_session` retains its documented listening-control semantics through
 *   the conversation lifecycle that owns listening in the client protocol:
 *   `start` opens listening, `stop` ends it. `should_respond: false` has no
 *   client-protocol equivalent (ASR finals in an active conversation always
 *   generate a response) and is rejected with an explicit error.
 * - `config` and `ping` have no client-protocol equivalent and are ignored.
 */
export async function sendVoiceClientMessage(
  ws: WebSocket,
  adapter: VoiceMessageAdapter,
  message: DHInputMessage,
  sendFrame: (frame: VoiceClientFrame) => void | Promise<void> = frame => ws.send(JSON.stringify(frame)),
): Promise<void> {
  const startsWork = message.type === 'input' || message.type === 'wakeup'
    || (message.type === 'sleep' && !!message.text?.trim())
    || (message.type === 'asr_session' && message.command === 'start')
  if (adapter.serviceNegotiated?.() && adapter.serviceState?.()?.status !== 'ready' && startsWork) {
    throw new Error('Service unavailable; request was not accepted.')
  }
  let frames: VoiceClientFrame[] = []
  switch (message.type) {
    case 'wakeup':
      frames = adapter.wakeup(message.text)
      break
    case 'sleep':
      frames = adapter.sleep(message.text)
      break
    case 'input': {
      const botText = typeof message.bot_text === 'string' ? message.bot_text.trim() : ''
      // Only an accepted clear command preserves prior input acknowledgment.
      // Ordinary, blank, and rejected bot_text inputs retain their existing
      // pending-sequence invalidation behavior.
      if (botText || message.text?.trim() !== '/clear') {
        adapter.invalidatePendingSequence()
      }
      if (botText) {
        throw new Error(
          'voice client mode cannot send input bot_text: the client protocol has no bot-authored text input; use text instead or the legacy direct-DH2D mode',
        )
      }
      if (message.text && message.text.trim()) {
        frames = [adapter.textInput(message.text)]
      }
      break
    }
    case 'asr_session': {
      if (message.command !== 'start' && message.command !== 'stop') {
        throw new Error(
          `voice client mode cannot map asr_session command ${JSON.stringify(message.command)}: expected 'start' or 'stop'`,
        )
      }
      if (message.should_respond === false) {
        throw new Error(
          'voice client mode cannot map asr_session should_respond=false: ASR finals in an active conversation always generate a response',
        )
      }
      frames = adapter.asrSession(message.command)
      break
    }
    default:
      break
  }
  await Promise.all(frames.map(sendFrame))
}

async function connectOnce(
  time: number,
  logger: Logger,
  elements: DH2DPlayerElements,
  config: ResolvedDH2DSessionConfig,
  innerAbortable: Abortable,
): Promise<VoiceClientConnection> {
  const voiceConfig = config.voiceClient!
  const offerController = new AbortController()
  innerAbortable.onabort(() => offerController.abort())
  const offers: Promise<void>[] = []
  const attemptLogger = logger.push((_, ...args) => _(`[attempt:${time}]`, ...args))
  attemptLogger.log('enter')
  let running = true
  innerAbortable.onabort(() => {
    running = false
  })
  let ownedStream: MediaStream | undefined
  const ownsVideo = () => ownedStream !== undefined && elements.video.srcObject === ownedStream
  let videoVisible = false
  const sessionId = voiceConfig.sessionId!
  const interactionUrl = new URL(voiceClientWebSocketUrl(voiceConfig.interaction_endpoint, config.videoId, sessionId))
  interactionUrl.searchParams.set('service_snapshot', 'v1')
  const ws = new WebSocket(interactionUrl.toString())
  innerAbortable.onabort(() => {
    ws.close()
  })
  const pc = new RTCPeerConnection(config.rtcConfiguration)
  innerAbortable.onabort(() => {
    pc.close()
  })
  const evt = events<DHConnectionEvents>()
  const snapshots = createSnapshotObservation()
  const subscribeEvent = evt.on
  evt.on = (event, handler) => {
    const unsubscribe = subscribeEvent(event, handler)
    if (event === 'message') adapter.replaySnapshot().forEach(message => (handler as (_: any) => void)(message))
    return unsubscribe
  }
  let canonicalSessionId: string | undefined = undefined
  let sessionLogger = attemptLogger
  let avatarPlayback: ReturnType<typeof createAvatarPlayback> | undefined = undefined
  const acceptedOutputTurns = new Set<string>()
  const pendingOutputStops = new Set<string>()
  const reportedOutputTurns = new Set<string>()
  const outputGeneration = new Map<string, number>()
  const receiverStats = createReceiverStats({ pc, logger: attemptLogger })
  let disposed = false
  let protocolConfirmed = false
  let acknowledgedEpoch: string | undefined
  let acknowledgedGeneration = -1
  const pendingText = new Map<string, { resolve: () => void, reject: (error: Error) => void }>()
  const rejectPendingText = (error: Error) => {
    for (const pending of pendingText.values()) pending.reject(error)
    pendingText.clear()
  }
  const sendVoice = (message: DHInputMessage) => sendVoiceClientMessage(ws, adapter, message, frame => {
    if (!adapter.serviceNegotiated() || frame.type !== 'text.input') {
      ws.send(JSON.stringify(frame))
      return
    }
    return new Promise<void>((resolve, reject) => {
      pendingText.set(frame.request_id, { resolve, reject })
      try { ws.send(JSON.stringify(frame)) }
      catch (error) { pendingText.delete(frame.request_id); reject(error) }
    })
  })
  let voiceBadge: HTMLElement | undefined
  let badgeKey: string | undefined
  const refreshVoiceBadge = () => {
    const state = adapter.serviceState()
    const serviceError = state?.status === 'unavailable' ? state.reason : undefined
    const inputError = adapter.audioInputError()
    const key = serviceError ? `service:${serviceError}` : inputError ? `input:${inputError}` : undefined
    if (key === badgeKey) return
    voiceBadge?.remove()
    voiceBadge = undefined
    badgeKey = key
    const container = elements.container
    if (!container) return
    if (serviceError) voiceBadge = createServiceUnavailableBadge(container.ownerDocument, serviceError)
    else if (inputError) voiceBadge = createMicrophoneErrorBadge(container.ownerDocument, inputError)
    if (voiceBadge) container.append(voiceBadge)
  }
  function diagnostic(line: () => string) {
    try {
      sessionLogger.log(line())
    } catch { /* metadata/getters and sinks are diagnostic only */ }
  }
  function mediaState() {
    const video = elements.video
    const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null
    const boolean = (value: unknown) => typeof value === 'boolean' ? value : null
    return `ready_state=${number(video.readyState)} current_time=${number(video.currentTime)}`
      + ` paused=${boolean(video.paused)} ended=${boolean(video.ended)}`
      + ` width=${number(video.videoWidth)} height=${number(video.videoHeight)}`
  }

  // Session traffic waits behind both socket OPEN and the client's exact
  // version acknowledgement. Only session.start bypasses this gate.
  const outbound: (string | Uint8Array)[] = []
  const sendFrame = (data: string | Uint8Array): 'suppressed' | 'queued' | 'sent' => {
    if (!running || disposed) {
      return 'suppressed'
    }
    if (ws.readyState !== WebSocket.OPEN || !protocolConfirmed) {
      outbound.push(data)
      return 'queued'
    }
    if (adapter.serviceNegotiated() && adapter.serviceState()?.status !== 'ready') {
      const type = typeof data === 'string' ? JSON.parse(data).type : undefined
      if (!['audio.input.released', 'capture.ended', 'playback.ended'].includes(type)) return 'suppressed'
    }
    ws.send(data)
    return 'sent'
  }

  const adapter = createVoiceMessageAdapter({
    sessionId,
    onClientSend: frame => sendFrame(JSON.stringify(frame)),
  })

  const inputControl = createVoiceInputControl({ sessionId,
    create: (onPcm, onLost) => {
      // Host-default routing cannot prove that an application-supplied
      // stream belongs to the selected physical source. Fail that override
      // explicitly rather than silently capturing a different device.
      if (config.audioInput !== true) throw new Error('host-default microphone input unavailable or overridden')
      return createVoiceMicrophone({ audioInput: config.audioInput, logger: attemptLogger, onPcm, onLost })
    },
    send: frame => sendFrame(frame instanceof Uint8Array ? frame : JSON.stringify(frame)),
  })
  innerAbortable.onabort(inputControl.dispose)

  function acknowledgePlaybackEnd(turnId: string, source?: 'stripe' | 'lifecycle', nextTurnId?: string) {
    if (reportedOutputTurns.has(turnId)
        || (adapter.serviceNegotiated() && !acceptedOutputTurns.has(turnId))) return
    reportedOutputTurns.add(turnId)
    acceptedOutputTurns.delete(turnId)
    // Point 6 is the existing receipt send boundary, independent of whether
    // frame observation is available. A stop receipt follows the explicit
    // native clear-buffer/stop protocol, not an inferred stripe or timer.
    try {
      sessionLogger.log(`avatar_playback_ended_sent turn=${turnId}`
        + ` next=${nextTurnId ?? '-'} source=${source ?? 'stripe'}`
        + ` now=${avatarTimingNow().toFixed(3)} epoch_ms=${Date.now()}`)
    } catch { /* diagnostics must not suppress the receipt */ }
    const ended = adapter.playbackEnded(turnId)
    const frame = JSON.stringify(adapter.serviceNegotiated() && source === 'stripe'
      ? { ...ended, disposition: 'played' } : ended)
    let disposition: 'suppressed' | 'queued' | 'sent'
    try {
      disposition = sendFrame(frame)
    } catch (error) {
      diagnostic(() => `avatar_playback_ended_transport turn=${/^[0-9A-Za-z]{2}$/.test(turnId) ? turnId : '-'} disposition=failed`)
      throw error // Preserve the existing transport failure path.
    }
    diagnostic(() => `avatar_playback_ended_transport turn=${/^[0-9A-Za-z]{2}$/.test(turnId) ? turnId : '-'} disposition=${disposition}`)
  }

  let bindingUI: ReturnType<typeof createChannelBindingUI> | undefined
  const configuredBinding = voiceConfig.wechatPluginEndpoint
    ? createChannelBindingToolHandler({
      endpoint: voiceConfig.wechatPluginEndpoint,
      onSnapshot: snapshot => bindingUI?.update(snapshot),
      onError: error => bindingUI?.error(error),
    })
    : undefined
  const frontendToolHandler: VoiceClientToolHandler | undefined =
    voiceConfig.frontendToolHandler ?? configuredBinding?.handler
  const bindingContainer = elements.container ?? elements.video.parentElement
  if (configuredBinding && bindingContainer) {
    bindingUI = createChannelBindingUI(bindingContainer, configuredBinding.workflow)
  }

  const handleFrontendToolCall = async (call: VoiceClientToolCall) => {
    let result: VoiceClientToolResult | undefined
    try {
      result = await frontendToolHandler?.(call)
    } catch {
      result = FRONTEND_TOOL_FAILURE
    }
    if (result === undefined || !running || disposed) return
    let encoded: string
    try {
      const normalizedResult = sanitizeFrontendToolResult(result)
      const resultFrame = normalizedResult.ok
        ? { ok: true as const, result: normalizedResult.result }
        : { ok: false as const, error: normalizedResult.error }
      const serialized = JSON.stringify({
        type: 'tool.result',
        session_id: call.session_id,
        turn_id: call.turn_id,
        call_id: call.call_id,
        ...resultFrame,
      })
      if (serialized === undefined || !isSerializedFrontendToolResult(JSON.parse(serialized), call)) {
        throw new Error('invalid serialized frontend tool result')
      }
      encoded = serialized
    } catch {
      encoded = JSON.stringify({
        type: 'tool.result',
        session_id: call.session_id,
        turn_id: call.turn_id,
        call_id: call.call_id,
        ...FRONTEND_TOOL_FAILURE,
      })
    }
    try {
      sendFrame(encoded)
    } catch {
      // A close racing the handler is a retired connection, not a tool error.
    }
  }

  const wsCloseHandlers: (() => void)[] = []
  ws.onclose = () => {
    for (const handler of [...wsCloseHandlers]) {
      handler()
    }
  }
  const wsOpen = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    wsCloseHandlers.push(() => reject(new Error('connection closed')))
    innerAbortable.onabort(() => reject(new Error('connection aborted')))
  })
  // The session handshake keeps its order as the first control frame by
  // waiting for the socket to reach OPEN.
  const handshakeReady = wsOpen.then(() => {
    if (!running || disposed) {
      return
    }
    ws.send(JSON.stringify(adapter.startFrame()))
  })
  let rejectConnection!: (error: Error) => void
  const failure = new Promise<never>((_, reject) => {
    rejectConnection = reject
    wsCloseHandlers.push(() => {
      if (running && !disposed) {
        reject(new Error('connection closed'))
      }
    })
    innerAbortable.onabort(() => reject(new Error('connection aborted')))
  })

  let acknowledgeProtocol!: () => void
  const protocolReady = new Promise<void>((resolve, reject) => {
    acknowledgeProtocol = resolve
    innerAbortable.onabort(() => reject(new Error('connection aborted')))
  })
  function failProtocol(detail: string) {
    const protocolError = new VoiceProtocolError(`voice protocol handshake failed: ${detail}`)
    // Readiness may already be fulfilled while media setup is still pending.
    // Fatal errors belong to the attempt's failure path, not its ready signal.
    rejectConnection(protocolError)
    try {
      elements.showError?.(`${protocolError.message}\nUpdate the client and SDK together, then reload.`)
    } finally {
      dispose()
      ws.close()
      pc.close()
    }
  }

  const videoReady = new Promise<void>((resolve, reject) => {
    innerAbortable.onabort(() => reject(new Error('connection aborted')))
    const video = elements.video
    let videoTrack = false
    let audioTrack = false
    const onTrack = (event: RTCTrackEvent) => {
      if (!running || (ownedStream !== undefined && !ownsVideo())) return
      if (event.track.kind === 'video') {
        sessionLogger.log('video track added')
        videoTrack = true
      } else if (event.track.kind === 'audio') {
        sessionLogger.log('audio track added')
        audioTrack = true
      }
      if (videoTrack && audioTrack) {
        ownedStream = event.streams[0]
        video.srcObject = ownedStream
        sessionLogger.log('video source ready')
      }
    }
    pc.addEventListener('track', onTrack)
    innerAbortable.onabort(() => pc.removeEventListener('track', onTrack))
    const onCanPlay = () => {
      if (!running || !ownsVideo()) return
      video.removeEventListener('canplay', onCanPlay)
      videoVisible = true
      const cover = elements.cover
      sessionLogger.log('video canplay')
      const play = video.play()
      // Observe the native promise without awaiting it or gating readiness.
      void play?.then(() => {
        if (!running || disposed || !ownsVideo()) return
        diagnostic(() => `avatar_media_play_result outcome=fulfilled ${mediaState()}`)
      }, (error: any) => {
        if (!running || disposed || !ownsVideo()) return
        let reason = 'failed'
        try {
          const name = error?.name
          if (name === 'NotAllowedError') reason = 'not_allowed'
          else if (name === 'AbortError') reason = 'aborted'
          else if (name === 'NotSupportedError') reason = 'unsupported'
        } catch { /* never inspect or serialize the exception body */ }
        diagnostic(() => `avatar_media_play_result outcome=rejected reason=${reason} ${mediaState()}`)
      })
      if (cover != null && cover.style.opacity != '0') {
        const timer = setTimeout(() => {
          if (!running || !ownsVideo()) return
          cover.style.opacity = '0'
          resolve()
        }, 500)
        innerAbortable.onabort(() => clearTimeout(timer))
      } else {
        resolve()
      }
    }
    video.addEventListener('canplay', onCanPlay)
    innerAbortable.onabort(() => video.removeEventListener('canplay', onCanPlay))
    let lastMediaEvent: string | undefined
    for (const name of ['playing', 'pause', 'waiting', 'ended']) {
      const onMediaEvent = () => {
        if (!running || disposed || !ownsVideo() || lastMediaEvent === name) return
        lastMediaEvent = name
        diagnostic(() => `avatar_media_event event=${name} ${mediaState()}`)
      }
      // Passive diagnostics only: these events never authorize a playback receipt.
      video.addEventListener(name, onMediaEvent, { passive: true })
      innerAbortable.onabort(() => video.removeEventListener(name, onMediaEvent))
    }
  })

  const avatarReady = new Promise<void>((resolve, reject) => {
    innerAbortable.onabort(() => reject(new Error('connection aborted')))
    ws.onmessage = (event: MessageEvent) => {
      if (!running || disposed) return
      if (typeof event.data !== 'string') {
        if (canonicalSessionId === undefined) {
          reject(new Error('binary voice client frame arrived before session-ready'))
          return
        }
        if (!protocolConfirmed) {
          failProtocol('binary input before version acknowledgement')
          return
        }
        // Output PCM follows its audio.output.delta control frame; avatar playback
        // audio arrives through the WebRTC media path instead.
        evt.emit('audio', event.data)
        return
      }
      let message: { type: string, [key: string]: any }
      try {
        const parsed = JSON.parse(event.data)
        if (parsed === null
            || typeof parsed !== 'object'
            || Array.isArray(parsed)
            || typeof parsed.type !== 'string') {
          throw new Error('voice client frame must have a type')
        }
        message = parsed
      } catch {
        if (canonicalSessionId === undefined) reject(new Error('invalid voice client frame'))
        return
      }
      if (message.type === 'error' && message.code === 'handshake_rejected') {
        failProtocol(typeof message.message === 'string' ? message.message : 'client rejected session.start')
        return
      }
      if (canonicalSessionId === undefined && message.type !== 'dh_2d_session_ready') {
        reject(new Error('voice client session-ready frame expected'))
        return
      }
      if (message.type === 'dh_2d_session_ready' && canonicalSessionId === undefined) {
        if (typeof message.session_id !== 'string' || !message.session_id
            || message.session_id === '.' || message.session_id === '..') {
          reject(new Error('voice client session-ready frame has an invalid session_id'))
          return
        }
        // Only session allocation: media readiness comes from the direct
        // WebRTC exchange below, not from this frame.
        canonicalSessionId = message.session_id
        sessionLogger = attemptLogger.push((_, ...args) => _(`[s:${canonicalSessionId}]`, ...args))
        sessionLogger.log('avatar session ready, exchanging offer directly')
        pc.addTransceiver('video', { direction: 'recvonly' })
        pc.addTransceiver('audio', { direction: 'recvonly' })
        // The offer exchange is a voice-client avatar operation: it targets
        // the configured `voiceClient.dh2d_endpoint` when set; a partial
        // config that omits it falls back to the legacy root service
        // endpoint.
        const offerEndpoint = voiceConfig.dh2d_endpoint || rootConfig().endpoint
        const encodedSessionId = encodeURIComponent(canonicalSessionId)
        const pcUrl = new URL(`${offerEndpoint.replace(/\/+$/, '')}/api/v1/session/${encodedSessionId}/offer`)
        pcUrl.protocol = pcUrl.protocol === 'https:' || pcUrl.protocol === 'wss:' ? 'https:' : 'http:'
        const offer = connectPc(pc, pcUrl.toString(), offerController.signal)
        offers.push(offer)
        offer.then(() => {
          sessionLogger.log('pc connected')
          resolve()
        })
          .catch(reject)
        return
      }
      if (message.type === 'session.state') {
        if (message.session_id !== sessionId || message.state !== 'connected'
            || message.protocol_version !== PROTOCOL_VERSION) {
          failProtocol(`expected connected session ${sessionId} with protocol version ${PROTOCOL_VERSION}; received ${String(message.protocol_version)}`)
          return
        }
        const offeredService = 'service_snapshot' in message || 'state_epoch' in message
        const negotiated = message.service_snapshot === 'v1'
          && typeof message.state_epoch === 'string' && !!message.state_epoch
          && Number.isSafeInteger(message.generation) && message.generation >= 0
        if (offeredService && !negotiated) {
          failProtocol('malformed service snapshot acknowledgement')
          return
        }
        if (acknowledgedEpoch) {
          // An old or duplicate acknowledgement must not re-key the projection,
          // reset input control, or acknowledge pending text on another execution.
          if (!negotiated || message.generation <= acknowledgedGeneration || message.state_epoch === acknowledgedEpoch) return
        }
        protocolConfirmed = true
        inputControl.synchronize()
        if (negotiated) {
          rejectPendingText(new Error('Text acceptance unknown: voice service execution changed.'))
          acknowledgedEpoch = message.state_epoch
          acknowledgedGeneration = message.generation
        }
        adapter.ingest(message)
        refreshVoiceBadge()
        snapshots.publish(adapter.snapshot())
        const early = outbound.splice(0)
        if (!adapter.serviceNegotiated()) for (const data of early) ws.send(data)
        acknowledgeProtocol()
        return
      }
      if (!protocolConfirmed) {
        failProtocol('expected versioned session.state acknowledgement')
        return
      }
      if (message.type === 'session.snapshot') {
        const changes = adapter.ingest(message)
        if (changes.length) {
          refreshVoiceBadge()
          snapshots.publish(adapter.snapshot())
        }
        for (const change of changes) evt.emit('message', change)
        return
      }
      if (message.session_id === adapter.sessionId && typeof message.request_id === 'string'
          && ((message.type === 'text.accepted' && typeof message.turn_id === 'string') || message.type === 'error')) {
        const pending = pendingText.get(message.request_id)
        if (pending) {
          pendingText.delete(message.request_id)
          if (message.type === 'text.accepted') pending.resolve()
          else pending.reject(new Error(typeof message.message === 'string' ? message.message : 'Voice text was refused.'))
        }
      }
      if (message.type === 'audio.output.start' && message.session_id === adapter.sessionId
          && typeof message.turn_id === 'string' && message.turn_id) {
        const turn = message.turn_id
        if (adapter.serviceNegotiated() && !acceptedOutputTurns.has(turn)
            && outputGeneration.get(turn) !== acknowledgedGeneration) {
          // Only a newly admitted output on the current execution can re-arm
          // a settled short ID. Repeated segments and pixels alone cannot.
          outputGeneration.set(turn, acknowledgedGeneration)
          reportedOutputTurns.delete(turn)
          avatarPlayback?.readmitOutput(turn)
        }
        if (!reportedOutputTurns.has(turn)) acceptedOutputTurns.add(turn)
      }
      if (message.type === 'playback.stop') {
        if ('disposition' in message) {
          if (!adapter.serviceNegotiated() || message.disposition !== 'retire'
              || message.session_id !== adapter.sessionId || typeof message.turn_id !== 'string') return
          const turn = message.turn_id
          reportedOutputTurns.add(turn)
          acceptedOutputTurns.delete(turn)
          pendingOutputStops.delete(turn)
          avatarPlayback?.notifyMediaEnded(turn, true) // Retire tracker; expected receipt is fenced above.
          return
        }
        // Explicit playback lifecycle end: the A-to-idle boundary. DH2D idle
        // frames are undecodable, so the boundary comes from this
        // protocol-safe signal and is never inferred from invalid stripes.
        // The signal is validated against this connection's voice session
        // and the accepted output/currently tracked turn. A queued accepted
        // turn is acknowledged by ID, without ending a different current turn.
        // The native client clears its output buffer before forwarding stop.
        if (message.session_id === undefined || message.session_id === adapter.sessionId) {
          const turnId = typeof message.turn_id === 'string' && message.turn_id ? message.turn_id : undefined
          const accepted = turnId !== undefined && acceptedOutputTurns.has(turnId)
          if (avatarPlayback) avatarPlayback.notifyMediaEnded(turnId, accepted)
          else if (accepted && turnId !== undefined) {
            pendingOutputStops.add(turnId)
            acknowledgePlaybackEnd(turnId, 'lifecycle')
          }
        }
      }
      if (message.type === 'tool.call') {
        const call = isFrontendToolCall(message) ? message : undefined
        if (call && call.session_id === adapter.sessionId && frontendToolHandler) {
          void handleFrontendToolCall(call)
        }
        // Raw tool calls are frontend execution traffic, never app-facing
        // adapter output and never a legacy start/finish presentation event.
        return
      }
      inputControl.ingest(message)
      for (const adapted of adapter.ingest(message)) {
        evt.emit('message', adapted)
      }
    }
  })

  // Input preparation is client-commanded and independent of media/text
  // connection readiness. Merely connecting never acquires a microphone.

  // Fences this connection generation. Detaching the websocket callbacks and
  // stopping the microphone prevents stale callbacks and queued events from a
  // retired connection from reaching the app; the video source is cleared so
  // no retired stream keeps rendering.
  let retirement: Promise<void> | undefined
  const dispose = () => {
    if (retirement) return retirement
    disposed = true
    rejectPendingText(new Error('Voice connection closed before text acceptance.'))
    // Fence input immediately, but retain its asynchronous acquisition/stop
    // retirement alongside signalling work. Abort callbacks cannot await it;
    // attempt failure and normal disconnect both join this same result.
    const inputRetirement = inputControl.dispose()
    retirement = Promise.allSettled([avatarReady, videoReady, handshakeReady, protocolReady, ...offers, inputRetirement]).then(results => {
      const inputResult = results[results.length - 1]
      if (inputResult.status === 'rejected') throw inputResult.reason
    })
    void retirement.catch(() => {})
    if (ownsVideo() && videoVisible) drawCover(attemptLogger, elements)
    running = false
    configuredBinding?.workflow.dispose()
    bindingUI?.dispose()
    voiceBadge?.remove()
    voiceBadge = undefined
    receiverStats.stop()
    avatarPlayback?.stop()
    ws.onopen = null
    ws.onclose = null
    ws.onmessage = null
    if (ownsVideo()) elements.video.srcObject = null
    innerAbortable.abort()
    snapshots.publish(undefined)
    snapshots.unsubscribe()
    return retirement
  }
  innerAbortable.onabort(dispose)

  try {
    await Promise.race([
      Promise.all([avatarReady, videoReady, handshakeReady, protocolReady]),
      failure,
    ])
    if (!running || disposed || !ownsVideo()) {
      throw new Error('connection aborted')
    }
  } catch (error) {
    innerAbortable.abort()
    // Cancellation fences continuations, but native/non-cooperative work still
    // owns the attempt until it actually settles.
    try {
      await dispose()
    } catch (retirementError) {
      if (!(error instanceof VoiceProtocolError)) throw retirementError
      // A failed cleanup must not turn a terminal protocol rejection into a retry.
      attemptLogger.error(retirementError)
    }
    throw error
  }
  receiverStats.request({ performanceOriginMs: typeof performance !== 'undefined' ? performance.timeOrigin : null })
  const frameRequester = hooks.dh2d.createAvatarFrameRequester(elements.video)
  if (frameRequester) {
    const playback = createAvatarPlayback({
      logger: sessionLogger,
      requestFrame: frameRequester,
      sampleFrame: hooks.dh2d.createAvatarFrameSampler(elements.video),
      createReadback: () => hooks.dh2d.createAvatarStripeReadback<AvatarFrameContext>(elements.video),
      onPlaybackEnded: acknowledgePlaybackEnd,
      onTurnObserved: turnId => {
        adapter.observeAvatarTurn(turnId)
      },
      onTurnChanged: (turnId, context) => {
        receiverStats.request({
          turnId,
          rtpTimestamp: context.rtpTimestamp,
          callbackNowMs: context.callbackNowMs,
          performanceOriginMs: context.performanceOriginMs,
        })
      },
    })
    avatarPlayback = playback
    playback.start()
    for (const turnId of pendingOutputStops) playback.notifyMediaEnded(turnId, true)
    pendingOutputStops.clear()
    const stopPlayback = () => {
      receiverStats.stop()
      playback.stop()
    }
    return {
      ...connectionBase(ws, pc, canonicalSessionId, adapter, stopPlayback, dispose, failure),
      sendVoice, onSnapshot: snapshots.subscribe,
      ...(({ on, off }) => ({ on, off }))(evt),
    }
  }
  sessionLogger.warn('requestVideoFrameCallback unavailable; avatar turn decoding disabled')
  return {
    ...connectionBase(ws, pc, canonicalSessionId, adapter, () => receiverStats.stop(), dispose, failure),
    sendVoice, onSnapshot: snapshots.subscribe,
    ...(({ on, off }) => ({ on, off }))(evt),
  }
}

function connectionBase(
  ws: WebSocket,
  pc: RTCPeerConnection,
  canonicalSessionId: string | undefined,
  adapter: VoiceMessageAdapter,
  stopPlayback: () => void,
  dispose: () => void | Promise<void>,
  failure: Promise<never>,
): Diff<VoiceClientConnection, { on: unknown, off: unknown, onSnapshot: unknown }> {
  return {
    get ws() { return ws },
    get pc() { return pc },
    get sessionId() { return canonicalSessionId ?? '' },
    voice: adapter,
    failure,
    stopPlayback,
    dispose,
  }
}

/**
 * Connects to the voice client in avatar mode and the DH2D avatar media path.
 *
 * The voice client websocket carries the voice protocol (session handshake,
 * adapted messages, playback.ended). The canonical DH2D session id reported
 * by `dh_2d_session_ready` is used for the direct WebRTC offer exchange
 * through the configured `voiceClient.dh2d_endpoint`; no DH2D command websocket
 * is opened and no second avatar session is created.
 * The configured `connectTimeout` triggers cancellation of a stalled attempt.
 * Owned work must still retire before retrying; non-cooperative work can keep
 * retirement pending without a forced cleanup deadline.
 */
export async function connectVoiceClient(
  logger: Logger,
  elements: DH2DPlayerElements,
  config: ResolvedDH2DSessionConfig,
  abortable: Abortable,
): Promise<VoiceClientConnection> {
  if (!config.voiceClient) {
    throw new Error('voiceClient configuration is required')
  }
  const sessionConfig = {
    ...config,
    voiceClient: {
      ...config.voiceClient,
      sessionId: config.voiceClient.sessionId || MAIN_VOICE_SESSION_ID,
    },
  }
  validateVoiceSessionId(sessionConfig.voiceClient.sessionId)
  elements.showError?.()
  const rootLogger = logger.push((_, ...args) => _('[voice-connect]', ...args))
  for (let i = 0; ; i++) {
    try {
      return await withChild(abortable, async innerAbortable => {
        const tasks: Promise<VoiceClientConnection>[] = [
          connectOnce(i, rootLogger, elements, sessionConfig, innerAbortable),
        ]
        const connectTimeout = config.connectTimeout
        if (connectTimeout > 0) {
          tasks.push(new Promise<VoiceClientConnection>((_, reject) => {
            setTimeout(() => reject(new Error(`connect timeout after ${connectTimeout}ms`)), connectTimeout)
          }))
        }
        try {
          return await Promise.race(tasks)
        } catch (error) {
          innerAbortable.abort()
          const [attempt] = await Promise.allSettled([tasks[0]])
          // Retirement may outlast the timer, but a protocol rejection stays terminal.
          if (attempt.status === 'rejected' && attempt.reason instanceof VoiceProtocolError) throw attempt.reason
          throw error
        }
      })
    } catch (e: any) {
      rootLogger.error(e)
      if (e instanceof VoiceProtocolError || e.message === 'connection aborted') {
        throw e
      }
      await withChild(abortable, scope => new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 2000)
        scope.onabort(() => {
          clearTimeout(timer)
          reject(new Error('connection aborted'))
        })
      }))
    }
  }
}

function drawCover(logger: Logger, elements: DH2DPlayerElements) {
  logger.log('draw cover')
  const cover = elements.cover
  const video = elements.video
  if (!cover) return
  const width = video.videoWidth
  const height = video.videoHeight
  if (!width || !height) return
  cover.width = width
  cover.height = height
  const ctx = cover.getContext('2d')
  if (ctx) {
    ctx.drawImage(video, 0, 0, width, height)
  }
  cover.style.opacity = '1'
}

export async function disconnectVoiceClient(
  logger: Logger,
  connection: DH2DConnection & Partial<Pick<VoiceClientConnection, 'voice' | 'stopPlayback' | 'dispose'>>,
  elements: DH2DPlayerElements,
  abortable: Abortable,
) {
  logger = logger.push((_, ...args) => _('[voice-disconnect]', ...args))
  logger.log('enter')
  void abortable
  try {
    // Only the owning connection may freeze or detach its media in dispose().
    // Fence the retired connection first: no stale websocket callback,
    // microphone batch, or queued event may reach the app afterwards.
    const retirement = connection.dispose?.()
    connection.stopPlayback?.()
    connection.voice?.reset()
    connection.ws.close()
    connection.pc.close()
    for (const event of DHConnectionEventTypes) {
      connection.off(event)
    }
    await retirement
  } catch (e) {
    logger.error(e)
    throw e
  } finally {
    logger.log('exit')
  }
}
