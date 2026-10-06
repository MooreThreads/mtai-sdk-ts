import { withChild } from "../abortable"
import { events } from "../events"
import { hooks } from "../hooks"
import { connectPc } from "../pc"
import { config as rootConfig } from "../config"
import { Abortable, DHConnectionEventTypes, DHConnectionEvents, DHInputMessage, Diff, Logger } from "../types"
import { createVoiceMessageAdapter, VoiceClientFrame, VoiceMessageAdapter } from "../voice/adapter"
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
}

function generateVoiceSessionId() {
  const cryptoApi = (globalThis as any).crypto
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return `voice_${cryptoApi.randomUUID()}` as string
  }
  return `voice_${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
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
 * given websocket. `config`, `ping`, and `asr_session` have no client-protocol
 * equivalent and are ignored; `wakeup` performs the stop-then-start sequence
 * through the adapter when a conversation is active.
 */
export async function sendVoiceClientMessage(
  ws: WebSocket,
  adapter: VoiceMessageAdapter,
  message: DHInputMessage,
): Promise<void> {
  let frames: VoiceClientFrame[] = []
  switch (message.type) {
    case 'wakeup':
      frames = adapter.wakeup()
      break
    case 'sleep':
      frames = adapter.sleep()
      break
    case 'input':
      if (message.text && message.text.trim()) {
        frames = [adapter.textInput(message.text)]
      }
      break
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
  const { endpoint } = rootConfig()
  const voiceConfig = config.voiceClient!
  const attemptLogger = logger.push((_, ...args) => _(`[attempt:${time}]`, ...args))
  attemptLogger.log('enter')
  let running = true
  innerAbortable.onabort(() => {
    running = false
  })
  const ws = new WebSocket(voiceClientWebSocketUrl(voiceConfig.url, config.videoId))
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
  const adapter = createVoiceMessageAdapter({
    sessionId: voiceConfig.sessionId || generateVoiceSessionId(),
    onClientSend: frame => {
      if (running) {
        ws.send(JSON.stringify(frame))
      }
    },
  })

  const failure = new Promise<never>((_, reject) => {
    innerAbortable.onabort(() => reject(new Error('connection aborted')))
    ws.onclose = () => {
      if (running) {
        reject(new Error('connection closed'))
      }
    }
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
      if (!running) return
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
        const pcUrl = new URL(`${endpoint}/api/v1/session/${canonicalSessionId}/offer`)
        pcUrl.protocol = pcUrl.protocol === 'https:' || pcUrl.protocol === 'wss:' ? 'https:' : 'http:'
        connectPc(pc, pcUrl.toString())
          .then(() => {
            sessionLogger.log('pc connected')
            resolve()
          })
          .catch(reject)
        return
      }
      for (const adapted of adapter.ingest(message)) {
        evt.emit('message', adapted)
      }
    }
  })

  // The websocket buffers sends made before the connection is open, so the
  // session handshake keeps its order as the first control frame.
  ws.send(JSON.stringify(adapter.startFrame()))

  await Promise.race([
    Promise.all([avatarReady, videoReady]),
    failure,
  ])

  const frameRequester = hooks.dh2d.createAvatarFrameRequester(elements.video)
  if (frameRequester) {
    const playback = createAvatarPlayback({
      logger: sessionLogger,
      requestFrame: frameRequester,
      sampleFrame: hooks.dh2d.createAvatarFrameSampler(elements.video),
      onPlaybackEnded: turnId => {
        if (running) {
          ws.send(JSON.stringify(adapter.playbackEnded(turnId)))
        }
      },
    })
    playback.start()
    return {
      ...connectionBase(ws, pc, canonicalSessionId, adapter, playback.stop),
      ...(({ on, off }) => ({ on, off }))(evt),
    }
  }
  sessionLogger.warn('requestVideoFrameCallback unavailable; avatar turn decoding disabled')
  return {
    ...connectionBase(ws, pc, canonicalSessionId, adapter, () => undefined),
    ...(({ on, off }) => ({ on, off }))(evt),
  }
}

function connectionBase(
  ws: WebSocket,
  pc: RTCPeerConnection,
  canonicalSessionId: string | undefined,
  adapter: VoiceMessageAdapter,
  stopPlayback: () => void,
): Diff<VoiceClientConnection, { on: unknown, off: unknown }> {
  return {
    get ws() { return ws },
    get pc() { return pc },
    get sessionId() { return canonicalSessionId ?? '' },
    voice: adapter,
    stopPlayback,
  }
}

/**
 * Connects to the voice client in avatar mode and the DH2D avatar media path.
 *
 * The voice client websocket carries the voice protocol (session handshake,
 * adapted messages, playback.ended). The canonical DH2D session id reported
 * by `dh_2d_session_ready` is used for the direct WebRTC offer exchange; no
 * DH2D command websocket is opened and no second avatar session is created.
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
      return await withChild(abortable, inner => connectOnce(i, rootLogger, elements, config, inner))
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
  connection: DH2DConnection & Partial<Pick<VoiceClientConnection, 'voice' | 'stopPlayback'>>,
  elements: DH2DPlayerElements,
  abortable: Abortable,
) {
  logger = logger.push((_, ...args) => _('[voice-disconnect]', ...args))
  logger.log('enter')
  void elements
  void abortable
  try {
    connection.stopPlayback?.()
    connection.voice?.reset()
    connection.ws.close()
    connection.pc.close()
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
