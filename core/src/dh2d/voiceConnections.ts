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
import { DH2DConnection, DH2DPlayerElements, ResolvedDH2DSessionConfig } from "./types"
import { createAvatarPlayback } from "./avatarMedia"

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

function generateVoiceSessionId() {
  const cryptoApi = (globalThis as any).crypto
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return `voice_${cryptoApi.randomUUID()}` as string
  }
  return `voice_${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

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

/**
 * Builds the frontend-to-client websocket URL: the avatar mode and selected
 * `video_id` are connection-query parameters, never protocol messages.
 */
export function voiceClientWebSocketUrl(base: string, videoId: string): string {
  const url = new URL(base)
  if (url.protocol === 'https:') {
    url.protocol = 'wss:'
  } else if (url.protocol === 'http:') {
    url.protocol = 'ws:'
  }
  if (!url.pathname || url.pathname === '/') {
    url.pathname = '/ws'
  }
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
 * - `input.text` maps to `text.input`; every `input` action — including one
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
      // Every SDK input action retires the pending sequence, even one whose
      // text turns out blank or that is rejected for `bot_text`; the adapter
      // actions invalidate internally too, so this happens before validation
      // and the later call is a harmless no-op.
      adapter.invalidatePendingSequence()
      const botText = typeof message.bot_text === 'string' ? message.bot_text.trim() : ''
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
  const ws = new WebSocket(voiceClientWebSocketUrl(voiceConfig.interaction_endpoint, config.videoId))
  innerAbortable.onabort(() => {
    ws.close()
  })
  const pc = new RTCPeerConnection(config.rtcConfiguration)
  innerAbortable.onabort(() => {
    pc.close()
  })
  const evt = events<DHConnectionEvents>()
  let canonicalSessionId: string | undefined = undefined
  let sessionLogger = attemptLogger
  let avatarPlayback: ReturnType<typeof createAvatarPlayback> | undefined = undefined
  let stopMicrophone: (() => void) | undefined = undefined
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
    sessionId: voiceConfig.sessionId || generateVoiceSessionId(),
    onClientSend: frame => sendFrame(JSON.stringify(frame)),
  })

  const configuredBinding = voiceConfig.wechatPluginEndpoint
    ? createChannelBindingToolHandler({
      endpoint: voiceConfig.wechatPluginEndpoint,
      onSnapshot: voiceConfig.wechatBinding?.onSnapshot,
      onError: voiceConfig.wechatBinding?.onError,
    })
    : undefined
  const frontendToolHandler: VoiceClientToolHandler | undefined =
    voiceConfig.frontendToolHandler ?? configuredBinding?.handler
  if (configuredBinding) {
    try {
      voiceConfig.wechatBinding?.onWorkflow?.(configuredBinding.workflow)
    } catch {
      // The consuming UI is an observer; a callback cannot break the voice path.
    }
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
      const resultFrame = isFrontendToolResult(result)
        ? result.ok
          ? { ok: true as const, result: result.result }
          : { ok: false as const, error: result.error }
        : FRONTEND_TOOL_FAILURE
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
        // Output PCM follows its audio.chunk control frame; avatar playback
        // audio arrives through the WebRTC media path instead.
        evt.emit('audio', event.data)
        return
      }
      const message = JSON.parse(event.data)
      if (message.type === 'dh_2d_session_ready' && canonicalSessionId === undefined) {
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
        const pcUrl = new URL(`${offerEndpoint}/api/v1/session/${canonicalSessionId}/offer`)
        pcUrl.protocol = pcUrl.protocol === 'https:' || pcUrl.protocol === 'wss:' ? 'https:' : 'http:'
        connectPc(pc, pcUrl.toString())
          .then(() => {
            sessionLogger.log('pc connected')
            resolve()
          })
          .catch(reject)
        return
      }
      if (message.type === 'playback.stop') {
        // Explicit playback lifecycle end: the A-to-idle boundary. DH2D idle
        // frames are undecodable, so the boundary comes from this
        // protocol-safe signal and is never inferred from invalid stripes.
        // The signal is validated against this connection's voice session
        // and the currently tracked avatar turn: a stop targeted at another
        // session or at a retired/queued turn must never retire the tracked
        // turn.
        if (message.session_id === undefined || message.session_id === adapter.sessionId) {
          const turnId = typeof message.turn_id === 'string' && message.turn_id ? message.turn_id : undefined
          avatarPlayback?.notifyMediaEnded(turnId)
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
      for (const adapted of adapter.ingest(message)) {
        evt.emit('message', adapted)
      }
    }
  })

  // Microphone PCM wiring: `audioInput` captures through the Web Audio API
  // and delivers each batch to the client as an input `audio.chunk` control
  // frame immediately followed by its binary PCM payload. The adapter only
  // accepts batches while a capture turn is active.
  let microphoneReady: Promise<void> = Promise.resolve()
  if (config.audioInput) {
    const microphone = createVoiceMicrophone({
      audioInput: config.audioInput,
      logger: attemptLogger,
      onPcm: pcm => {
        const batch = adapter.audioInput(pcm)
        if (!batch) {
          return
        }
        sendFrame(JSON.stringify(batch.control))
        sendFrame(batch.binary)
      },
    })
    stopMicrophone = microphone.stop
    innerAbortable.onabort(microphone.stop)
    microphoneReady = microphone.ready
  }

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
    stopMicrophone?.()
    ws.onopen = null
    ws.onclose = null
    ws.onmessage = null
    elements.video.srcObject = null
  }
  innerAbortable.onabort(dispose)

  await Promise.race([
    Promise.all([avatarReady, videoReady, handshakeReady, microphoneReady]),
    failure,
  ])

  const frameRequester = hooks.dh2d.createAvatarFrameRequester(elements.video)
  if (frameRequester) {
    const playback = createAvatarPlayback({
      logger: sessionLogger,
      requestFrame: frameRequester,
      sampleFrame: hooks.dh2d.createAvatarFrameSampler(elements.video),
      onPlaybackEnded: turnId => {
        sendFrame(JSON.stringify(adapter.playbackEnded(turnId)))
      },
      onTurnObserved: turnId => {
        adapter.observeAvatarTurn(turnId)
      },
    })
    avatarPlayback = playback
    playback.start()
    return {
      ...connectionBase(ws, pc, canonicalSessionId, adapter, playback.stop, dispose),
      ...(({ on, off }) => ({ on, off }))(evt),
    }
  }
  sessionLogger.warn('requestVideoFrameCallback unavailable; avatar turn decoding disabled')
  return {
    ...connectionBase(ws, pc, canonicalSessionId, adapter, () => undefined, dispose),
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
  const rootLogger = logger.push((_, ...args) => _('[voice-connect]', ...args))
  for (let i = 0; ; i++) {
    try {
      return await withChild(abortable, async innerAbortable => {
        const tasks: Promise<VoiceClientConnection>[] = [
          connectOnce(i, rootLogger, elements, config, innerAbortable),
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
