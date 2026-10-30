import { withChild } from "../abortable"
import { config as rootConfig } from "../config"
import { events } from "../events"
import { hooks } from "../hooks"
import { connectPc } from "../pc"
import { Abortable, DHConnectionEventTypes, DHConnectionEvents, DHInputMessage, Diff, Logger } from "../types"
import { createVoiceMessageAdapter, VoiceClientFrame, VoiceMessageAdapter } from "../voice/adapter"
import {
  createChannelBindingToolHandler,
  type VoiceClientToolCall,
  type VoiceClientToolHandler,
  type VoiceClientToolResult,
} from "../voice/channelBinding"
import { createVoiceMicrophone } from "../voice/microphone"
import { createVoiceInputControl } from '../voice/inputControl'
import { DH2DConnection, DH2DPlayerElements, ResolvedDH2DSessionConfig } from "./types"
import { avatarTimingNow, createAvatarPlayback } from "./avatarMedia"
import { createReceiverStats } from "./receiverStats"
import { createChannelBindingUI } from '../voice/channelBindingUI'

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
  /** Stops avatar playback observation. */
  readonly stopPlayback: () => void,
  /**
   * Fences this connection generation: detaches the client websocket
   * callbacks, stops the microphone pipeline, and clears the video source,
   * so traffic from a retired connection can never reach the app.
   */
  readonly dispose: () => void,
}

const MAIN_VOICE_SESSION_ID = 'avatar-channel-session'

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
): Promise<void> {
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
  frames.forEach(frame => ws.send(JSON.stringify(frame)))
}

async function connectOnce(
  time: number,
  logger: Logger,
  elements: DH2DPlayerElements,
  config: ResolvedDH2DSessionConfig,
  innerAbortable: Abortable,
): Promise<VoiceClientConnection> {
  const voiceConfig = config.voiceClient!
  const attemptLogger = logger.push((_, ...args) => _(`[attempt:${time}]`, ...args))
  attemptLogger.log('enter')
  let running = true
  innerAbortable.onabort(() => {
    running = false
  })
  // Freeze the last rendered avatar frame over the video element when this
  // attempt tears down, so the reconnect wait never exposes the black video
  // node. The handler is registered before every teardown handler that clears
  // the frame (`video.srcObject = null`), and abort handlers run in
  // registration order, so the cover is drawn while the frame still exists.
  // The next `canplay` hides it again.
  let videoVisible = false
  innerAbortable.onabort(() => {
    if (videoVisible) {
      drawCover(attemptLogger, elements)
    }
  })
  const sessionId = voiceConfig.sessionId!
  const ws = new WebSocket(voiceClientWebSocketUrl(voiceConfig.interaction_endpoint, config.videoId, sessionId))
  innerAbortable.onabort(() => {
    ws.close()
  })
  const pc = new RTCPeerConnection(config.rtcConfiguration)
  innerAbortable.onabort(() => {
    pc.close()
  })
  const evt = events<DHConnectionEvents>()
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
  const receiverStats = createReceiverStats({ pc, logger: attemptLogger })
  let disposed = false

  // The native websocket throws on send() while still CONNECTING, so every
  // client-protocol frame is sent through this gate: frames produced before
  // OPEN queue in order behind the session handshake.
  const outbound: (string | Uint8Array)[] = []
  const sendFrame = (data: string | Uint8Array) => {
    if (!running || disposed) {
      return
    }
    if (ws.readyState !== WebSocket.OPEN) {
      outbound.push(data)
      return
    }
    ws.send(data)
  }

  const adapter = createVoiceMessageAdapter({
    sessionId,
    controlledInput: true,
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
    if (reportedOutputTurns.has(turnId)) return
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
    sendFrame(JSON.stringify(adapter.playbackEnded(turnId)))
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
    for (const data of outbound.splice(0)) {
      ws.send(data)
    }
  })
  const failure = new Promise<never>((_, reject) => {
    wsCloseHandlers.push(() => {
      if (running && !disposed) {
        reject(new Error('connection closed'))
      }
    })
    innerAbortable.onabort(() => reject(new Error('connection aborted')))
  })

  const videoReady = new Promise<void>(resolve => {
    const video = elements.video
    let videoTrack = false
    let audioTrack = false
    const onTrack = (event: RTCTrackEvent) => {
      if (!running) return
      if (event.track.kind === 'video') {
        sessionLogger.log('video track added')
        videoTrack = true
      } else if (event.track.kind === 'audio') {
        sessionLogger.log('audio track added')
        audioTrack = true
      }
      if (videoTrack && audioTrack) {
        video.srcObject = event.streams[0]
        innerAbortable.onabort(() => video.srcObject = null)
        sessionLogger.log('video source ready')
      }
    }
    pc.addEventListener('track', onTrack)
    innerAbortable.onabort(() => pc.removeEventListener('track', onTrack))
    const onCanPlay = () => {
      video.removeEventListener('canplay', onCanPlay)
      videoVisible = true
      const cover = elements.cover
      sessionLogger.log('video canplay')
      video.play()
      if (cover != null && cover.style.opacity != '0') {
        setTimeout(() => {
          cover.style.opacity = '0'
          resolve()
        }, 500)
      } else {
        resolve()
      }
    }
    video.addEventListener('canplay', onCanPlay)
    innerAbortable.onabort(() => video.removeEventListener('canplay', onCanPlay))
  })

  const avatarReady = new Promise<void>((resolve, reject) => {
    ws.onmessage = (event: MessageEvent) => {
      if (!running || disposed) return
      if (typeof event.data !== 'string') {
        if (canonicalSessionId === undefined) {
          reject(new Error('binary voice client frame arrived before session-ready'))
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
        connectPc(pc, pcUrl.toString())
          .then(() => {
            sessionLogger.log('pc connected')
            resolve()
          })
          .catch(reject)
        return
      }
      if (message.type === 'audio.output.start' && message.session_id === adapter.sessionId
          && typeof message.turn_id === 'string' && message.turn_id && !reportedOutputTurns.has(message.turn_id)) {
        acceptedOutputTurns.add(message.turn_id)
      }
      if (message.type === 'playback.stop') {
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
      if (message.type === 'session.state' && message.session_id === adapter.sessionId && message.state === 'connected') inputControl.synchronize()
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
  const dispose = () => {
    if (disposed) {
      return
    }
    disposed = true
    running = false
    configuredBinding?.workflow.dispose()
    bindingUI?.dispose()
    receiverStats.stop()
    avatarPlayback?.stop()
    inputControl.dispose()
    ws.onopen = null
    ws.onclose = null
    ws.onmessage = null
    elements.video.srcObject = null
  }
  innerAbortable.onabort(dispose)

  await Promise.race([
    Promise.all([avatarReady, videoReady, handshakeReady]),
    failure,
  ])

  if (!running || disposed) {
    throw new Error('connection aborted')
  }
  receiverStats.request({ performanceOriginMs: typeof performance !== 'undefined' ? performance.timeOrigin : null })
  const frameRequester = hooks.dh2d.createAvatarFrameRequester(elements.video)
  if (frameRequester) {
    const playback = createAvatarPlayback({
      logger: sessionLogger,
      requestFrame: frameRequester,
      sampleFrame: hooks.dh2d.createAvatarFrameSampler(elements.video),
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
      ...connectionBase(ws, pc, canonicalSessionId, adapter, stopPlayback, dispose),
      ...(({ on, off }) => ({ on, off }))(evt),
    }
  }
  sessionLogger.warn('requestVideoFrameCallback unavailable; avatar turn decoding disabled')
  return {
    ...connectionBase(ws, pc, canonicalSessionId, adapter, () => receiverStats.stop(), dispose),
    ...(({ on, off }) => ({ on, off }))(evt),
  }
}

function connectionBase(
  ws: WebSocket,
  pc: RTCPeerConnection,
  canonicalSessionId: string | undefined,
  adapter: VoiceMessageAdapter,
  stopPlayback: () => void,
  dispose: () => void,
): Diff<VoiceClientConnection, { on: unknown, off: unknown }> {
  return {
    get ws() { return ws },
    get pc() { return pc },
    get sessionId() { return canonicalSessionId ?? '' },
    voice: adapter,
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
 * The configured `connectTimeout` bounds each attempt so a stalled attempt
 * can never hang the connection loop.
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
        return await Promise.race(tasks)
      })
    } catch (e: any) {
      rootLogger.error(e)
      if (e.message === 'connection aborted') {
        throw e
      }
      await new Promise(resolve => setTimeout(resolve, 2000))
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
    // Freeze the last rendered frame over the video node before `dispose()`
    // clears the source: the reconnect wait must show the last frame, not the
    // black video element. The next `canplay` hides the cover again.
    drawCover(logger, elements)
    // Fence the retired connection first: no stale websocket callback,
    // microphone batch, or queued event may reach the app afterwards.
    connection.dispose?.()
    connection.stopPlayback?.()
    connection.voice?.reset()
    connection.ws.close()
    connection.pc.close()
    elements.video.srcObject = null
    for (const event of DHConnectionEventTypes) {
      connection.off(event)
    }
  } catch (e) {
    logger.error(e)
    throw e
  } finally {
    logger.log('exit')
  }
}
