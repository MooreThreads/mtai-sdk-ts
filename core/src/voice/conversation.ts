import { events } from '../events'
import type { DHInputMessage, DHOutputMessage, Logger } from '../types'
import type { DH2DVoiceClientConfig } from '../dh2d/types'
import { createVoiceMessageAdapter, PROTOCOL_VERSION } from './adapter'
import { createVoiceInputControl } from './inputControl'
import { createVoiceMicrophone, type VoiceMicrophone } from './microphone'
import { createConversationBinding, type ConversationBinding } from './conversationBinding'
import { createTurnTransitionTracker } from './turnTransition'
import { VoiceProtocolError, voiceClientWebSocketUrl, sendVoiceClientMessage,
  isFrontendToolCall, isSerializedFrontendToolResult, sanitizeFrontendToolResult, FRONTEND_TOOL_FAILURE } from './conversationProtocol'
import type { AvatarAttachment, AvatarMediaEvent, AvatarMediaHost, AvatarStatus } from './avatarMediaHost'

export type ConversationEvents = {
  message: DHOutputMessage,
  /** Notification only; paired avatar audio belongs exclusively to mediaHost. */
  audio: unknown,
  mediaStatus: AvatarStatus,
}

/** Internal SDK seam. Public session/React integration supplies these owners;
 * applications do not construct native adapters or per-frame callbacks.
 */
export type ConversationOptions = {
  voice: DH2DVoiceClientConfig & { sessionId: string },
  videoId: string,
  mediaHost: AvatarMediaHost,
  logger: Logger,
  audioInput?: boolean | MediaStream,
  bindingContainer?: HTMLElement,
  binding?: ConversationBinding,
  socketFactory?: (url: string) => WebSocket,
  attachmentIdFactory?: () => string,
  microphoneFactory?: (onPcm: (data: Uint8Array) => void, onLost: () => void) => VoiceMicrophone,
}

/** Owns one voice-WebSocket attempt, independently of media presentation.
 * No RTC/stripe/pixel/native implementation, timer, retry or queue bound lives
 * here. The existing session coordinator retains its connection timeout/retry
 * placement; media reattachment never closes conversation-owned QR/tools.
 */
export function createConversationConnection(options: ConversationOptions) {
  const sessionId = options.voice.sessionId
  const ws = (options.socketFactory ?? (url => new WebSocket(url)))(
    voiceClientWebSocketUrl(options.voice.interaction_endpoint, options.videoId, sessionId),
  )
  const evt = events<ConversationEvents>()
  let disposed = false, protocolConfirmed = false, startSent = false
  let canonical: string | undefined
  let target: AvatarAttachment | undefined
  let mediaHealthy = false, mediaStatus: AvatarStatus = 'loading'
  let mediaStatusRevision = 0
  let mediaStatusListeners: ((status: AvatarStatus) => void)[] = []
  let lastSequence = 0n
  let retirement: Promise<void> | undefined
  let mediaTransition: Promise<void> = Promise.resolve()
  let mediaRevision = 0
  const stops = new Set<Promise<void>>()
  const outbound: (string | Uint8Array)[] = []
  const accepted = new Set<string>(), reported = new Set<string>()
  const tracker = createTurnTransitionTracker()
  let resolveReady!: () => void, rejectReady!: (error: Error) => void, rejectFailure!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const failure = new Promise<never>((_, reject) => { rejectFailure = reject })
  void ready.catch(() => {})
  void failure.catch(() => {})
  function sendFrame(data: string | Uint8Array) {
    if (disposed) return
    if (ws.readyState !== 1 || !protocolConfirmed) outbound.push(data)
    else ws.send(data)
  }
  const adapter = createVoiceMessageAdapter({ sessionId, onClientSend: frame => sendFrame(JSON.stringify(frame)) })
  const input = createVoiceInputControl({ sessionId,
    send: frame => sendFrame(frame instanceof Uint8Array ? frame : JSON.stringify(frame)),
    create: (onPcm, onLost) => {
    if (options.microphoneFactory) return options.microphoneFactory(onPcm, onLost)
    if (options.audioInput !== true) throw new Error('host-default microphone input unavailable or overridden')
    return createVoiceMicrophone({ audioInput: true, logger: options.logger, onPcm, onLost })
  } })
  const ownedBinding = !options.binding && options.voice.wechatPluginEndpoint
    ? createConversationBinding(options.voice.wechatPluginEndpoint, options.bindingContainer) : undefined
  const toolHandler = options.voice.frontendToolHandler ?? options.binding?.handler ?? ownedBinding?.handler

  function setMediaStatus(status: AvatarStatus) {
    if (disposed || mediaStatus === status) return
    mediaStatus = status
    const revision = ++mediaStatusRevision
    // Listener storage is immutable during dispatch. A reentrant detach can
    // emit loading, or close can retire the connection, before the next call.
    const listeners = mediaStatusListeners
    for (const listener of listeners) {
      if (disposed || revision !== mediaStatusRevision) break
      listener(status)
    }
  }
  function offMediaStatus(handler?: (status: AvatarStatus) => void) {
    mediaStatusListeners = handler ? mediaStatusListeners.filter(listener => listener !== handler) : []
  }
  function mediaFailed(generation: string) {
    if (disposed || target?.generation !== generation) return
    mediaHealthy = false
    setMediaStatus('failed') // not conversation failure and not QR disposal
  }
  function ownStop(operation: Promise<void>, generation: string) {
    stops.add(operation)
    void operation.then(() => stops.delete(operation), () => {
      // Keep rejected retirement owned until close can report the failure.
      mediaFailed(generation)
    })
    return operation
  }
  function stopMedia(request: Parameters<AvatarMediaHost['stop']>[0]) {
    // A native adapter can fail synchronously as well as reject asynchronously.
    // Both remain owned cleanup work, independent of baseline receipt timing.
    let operation: Promise<void>
    try { operation = options.mediaHost.stop(request) }
    catch (error) { operation = Promise.reject(error) }
    return ownStop(operation, request.generation)
  }
  function acknowledge(turnId: string) {
    if (disposed || reported.has(turnId)) return
    reported.add(turnId)
    accepted.delete(turnId)
    sendFrame(JSON.stringify(adapter.playbackEnded(turnId)))
  }
  function observeMedia(event: AvatarMediaEvent) {
    if (disposed || event.generation !== target?.generation) return
    if (event.type === 'failed') { mediaFailed(event.generation); return }
    if (!mediaHealthy) return
    if (event.sequence <= lastSequence) return
    if (event.sequence !== lastSequence + 1n) { mediaFailed(event.generation); return }
    lastSequence = event.sequence
    // Commit the already-applied observation before readiness subscribers can
    // detach/remount the view; they cannot retroactively unplay a valid A→B.
    const { endedTurnId, observedTurnId } = tracker.observe(event.turnId ? [event.turnId] : [])
    if (endedTurnId !== undefined) acknowledge(endedTurnId)
    if (!disposed && observedTurnId !== undefined) adapter.observeAvatarTurn(observedTurnId)
    if (disposed || target?.generation !== event.generation || !mediaHealthy) return
    setMediaStatus('ready')
  }
  const unsubscribeMedia = options.mediaHost.subscribe(observeMedia)

  function attachMedia(): Promise<void> {
    const revision = ++mediaRevision
    const operation = mediaTransition.then(async () => {
      if (disposed || revision !== mediaRevision || canonical === undefined) return
      if (!target || !mediaHealthy) {
        if (target) {
          const old = target
          target = undefined // fence callbacks before asynchronous retirement
          await stopMedia({ generation: old.generation, reason: 'detach' })
        }
        if (disposed || revision !== mediaRevision) return
        // Notify before installing a provisional target: a reentrant attach
        // must never reuse an owner which has not reached the host.
        setMediaStatus('loading')
        if (disposed || revision !== mediaRevision) return
        const identity = (options.attachmentIdFactory ?? (() => crypto.randomUUID()))()
        const next: AvatarAttachment = { conversationSessionId: sessionId, dh2dSessionId: canonical, avatarId: options.videoId,
          generation: identity, attachment: identity }
        target = next
        lastSequence = 0n
        // Acceptance can emit sequence 1 before the await continuation.
        // The captured target already fences that healthy observation.
        mediaHealthy = true
        try {
          await options.mediaHost.attach(next)
        } catch {
          mediaFailed(next.generation)
          return // caller can explicitly retry failed local attachment
        }
        if (target !== next || !mediaHealthy) return
      }
      if (disposed || revision !== mediaRevision) return
      if (!startSent) {
        ws.send(JSON.stringify(adapter.startFrame()))
        startSent = true
      }
    })
    // Observe rejection without replacing it with a successful barrier: a
    // failed native retirement must not admit a replacement audio owner.
    mediaTransition = operation
    void operation.catch(() => {})
    return operation
  }

  function detachMedia(): Promise<void> {
    ++mediaRevision // invalidate even an attach queued before installing target
    const superseded = mediaTransition
    const old = target
    target = undefined
    mediaHealthy = false
    let finishStop!: () => void, failStop!: (reason: unknown) => void
    const stop = new Promise<void>((resolve, reject) => { finishStop = resolve; failStop = reject })
    const operation = Promise.allSettled([stop, superseded]).then(results => {
      const rejected = results.find(result => result.status === 'rejected')
      if (rejected?.status === 'rejected') throw rejected.reason
    })
    // Publish first: both a native callback and a loading subscriber can
    // synchronously request replacement. Neither may bypass this retirement.
    mediaTransition = operation
    void operation.catch(() => {})
    if (old) void stopMedia({ generation: old.generation, reason: 'detach' }).then(finishStop, failStop)
    else finishStop()
    setMediaStatus('loading')
    return operation
  }

  async function handleTool(value: unknown) {
    if (!isFrontendToolCall(value) || value.session_id !== sessionId || !toolHandler) return
    let result
    try { result = await toolHandler(value) } catch { result = FRONTEND_TOOL_FAILURE }
    if (result === undefined || disposed) return
    let encoded: string
    try {
      const frame = { type: 'tool.result', session_id: value.session_id, turn_id: value.turn_id,
        call_id: value.call_id, ...sanitizeFrontendToolResult(result) }
      encoded = JSON.stringify(frame)
      if (!isSerializedFrontendToolResult(JSON.parse(encoded), value)) throw new Error('invalid frontend result')
    } catch {
      encoded = JSON.stringify({ type: 'tool.result', session_id: value.session_id, turn_id: value.turn_id,
        call_id: value.call_id, ...FRONTEND_TOOL_FAILURE })
    }
    sendFrame(encoded)
  }

  function fail(error: Error) {
    if (disposed) return
    rejectReady(error)
    rejectFailure(error)
    void close().catch(() => {})
  }
  function protocolError(detail: string) { fail(new VoiceProtocolError(`voice protocol handshake failed: ${detail}`)) }

  ws.onmessage = event => {
    if (disposed) return
    if (typeof event.data !== 'string') {
      if (canonical === undefined || !protocolConfirmed) { protocolError('binary input before version acknowledgement'); return }
      evt.emit('audio', event.data) // never play paired PCM here
      return
    }
    let message: { type: string, [key: string]: any }
    try {
      const parsed = JSON.parse(event.data)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.type !== 'string') throw new Error('invalid frame')
      message = parsed
    } catch {
      if (canonical === undefined) protocolError('invalid initial voice client frame')
      return
    }
    if (message.type === 'error' && message.code === 'handshake_rejected') { protocolError('client rejected session.start'); return }
    if (canonical === undefined) {
      if (message.type !== 'dh_2d_session_ready' || typeof message.session_id !== 'string'
          || !message.session_id || message.session_id === '.' || message.session_id === '..') {
        protocolError('canonical DH2D session-ready expected'); return
      }
      canonical = message.session_id
      void attachMedia().catch(error => fail(error instanceof Error ? error : new Error('media retirement failed')))
      return
    }
    if (message.type === 'session.state') {
      if (!startSent || message.session_id !== sessionId || message.state !== 'connected'
          || message.protocol_version !== PROTOCOL_VERSION) { protocolError('invalid versioned session.state'); return }
      protocolConfirmed = true
      input.synchronize()
      adapter.ingest(message)
      for (const frame of outbound.splice(0)) ws.send(frame)
      resolveReady()
      return
    }
    if (!protocolConfirmed) { protocolError('expected versioned session.state acknowledgement'); return }
    if (message.type === 'audio.output.start' && message.session_id === sessionId
        && typeof message.turn_id === 'string' && message.turn_id && !reported.has(message.turn_id)) accepted.add(message.turn_id)
    if (message.type === 'playback.stop' && (message.session_id === undefined || message.session_id === sessionId)) {
      const turnId = typeof message.turn_id === 'string' && message.turn_id ? message.turn_id : tracker.currentTurn()
      if (turnId !== undefined && (accepted.has(turnId) || tracker.currentTurn() === turnId)) {
        const generation = target?.generation
        if (generation) stopMedia({ generation, turnId, reason: 'interrupt' })
        // Native dispatch may synchronously apply B (and retire A). Always
        // retire the captured A, never whatever is current after that callback.
        const result = tracker.endAcceptedTurn(turnId)
        if (result.endedTurnId !== undefined) acknowledge(result.endedTurnId)
      }
    }
    if (message.type === 'tool.call') { void handleTool(message); return }
    input.ingest(message)
    for (const adapted of adapter.ingest(message)) evt.emit('message', adapted)
  }
  ws.onclose = () => { if (!disposed) fail(new Error('voice client connection closed')) }
  ws.onerror = () => { if (!disposed) fail(new Error('voice client connection failed')) }

  function close(): Promise<void> {
    if (retirement) return retirement
    disposed = true // synchronous fence, before any asynchronous cleanup
    ++mediaStatusRevision
    mediaStatusListeners = []
    rejectReady(new Error('connection aborted'))
    target = undefined
    ws.onmessage = ws.onclose = ws.onerror = ws.onopen = null
    outbound.length = 0
    retirement = (async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(unsubscribeMedia),
        Promise.resolve().then(() => ws.close()),
        Promise.resolve().then(() => ownedBinding?.dispose()),
        Promise.resolve().then(() => input.dispose()),
        Promise.resolve().then(() => options.mediaHost.dispose()),
        mediaTransition,
        ...stops,
      ])
      const failed = results.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    })()
    void retirement.catch(() => {})
    return retirement
  }

  return {
    ws, voice: adapter, ready, failure, attachMedia, detachMedia, close,
    get sessionId() { return canonical ?? '' },
    get connected() { return protocolConfirmed && !disposed },
    get mediaStatus() { return mediaStatus },
    async send(message: DHInputMessage) {
      if (disposed) throw new Error('Trying to send message after connection is closed')
      await sendVoiceClientMessage({ send: data => {
        if (typeof data !== 'string') throw new TypeError('conversation controls must be text')
        sendFrame(data)
      } }, adapter, message)
    },
    on: ((event: keyof ConversationEvents, handler: (value: any) => void) => {
      if (event === 'mediaStatus') {
        if (disposed) return () => undefined
        mediaStatusListeners = [...mediaStatusListeners, handler]
        handler(mediaStatus)
        return () => offMediaStatus(handler)
      }
      const off = evt.on(event, handler)
      if (event === 'message' && protocolConfirmed && !disposed) adapter.replaySnapshot().forEach(handler)
      return off
    }) as typeof evt.on,
    off: ((event: keyof ConversationEvents, handler?: (value: any) => void) => {
      if (event === 'mediaStatus') offMediaStatus(handler)
      else if (handler) evt.off(event, handler)
      else evt.off(event)
    }) as typeof evt.off,
  }
}
