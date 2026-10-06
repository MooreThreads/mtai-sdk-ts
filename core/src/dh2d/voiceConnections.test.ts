import { abortable, withChild } from '../abortable'
import { createLogger } from '../log'
import { hooks } from '../hooks'
import {
  connectVoiceClient,
  disconnectVoiceClient,
  sendVoiceClientMessage,
} from './voiceConnections'
import { createVoiceMessageAdapter } from '../voice/adapter'
import { crc16 } from './turnStripe'

class FakeEventTarget {
  private readonly listeners = new Map<string, Set<(_: any) => void>>()
  addEventListener(event: string, listener: (_: any) => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(listener)
  }
  removeEventListener(event: string, listener: (_: any) => void) {
    this.listeners.get(event)?.delete(listener)
  }
  dispatch(event: string, payload: any = {}) {
    this.listeners.get(event)?.forEach(listener => listener(payload))
  }
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  readonly url: string
  readonly sent: any[] = []
  readonly prematureSends: any[] = []
  readyState = FakeWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data: any }) => void) | null = null
  onclose: (() => void) | null = null
  closed = false
  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }
  send(data: any) {
    if (this.readyState !== FakeWebSocket.OPEN) {
      this.prematureSends.push(data)
      throw new Error(`premature websocket send while readyState=${this.readyState}`)
    }
    this.sent.push(data)
  }
  open() {
    if (this.readyState === FakeWebSocket.CONNECTING) {
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.()
    }
  }
  close() {
    this.closed = true
    this.readyState = FakeWebSocket.CLOSED
  }
  receive(data: string | ArrayBuffer) { this.onmessage?.({ data }) }
}

class FakeRTCPeerConnection extends FakeEventTarget {
  static instances: FakeRTCPeerConnection[] = []
  readonly transceivers: { kind: string, direction: string }[] = []
  remoteDescription: any = undefined
  connectionState = 'new'
  iceGatheringState = 'complete'
  localDescription = { type: 'offer', sdp: 'offer-sdp' }
  closed = false
  constructor() {
    super()
    FakeRTCPeerConnection.instances.push(this)
  }
  addTransceiver(kind: string, init?: RTCRtpTransceiverInit) {
    this.transceivers.push({ kind, direction: init?.direction ?? 'sendrecv' })
  }
  async createOffer() { return this.localDescription }
  async setLocalDescription() { }
  async setRemoteDescription(description: any) { this.remoteDescription = description }
  close() { this.closed = true }
}

class FakeMicrophoneStream {
  static instances: FakeMicrophoneStream[] = []
  readonly audioTracks: { stop: jest.Mock }[]
  constructor() {
    this.audioTracks = [{ stop: jest.fn() }]
    FakeMicrophoneStream.instances.push(this)
  }
  getAudioTracks() { return this.audioTracks }
}

class FakeMicrophoneAudioContext {
  static instances: FakeMicrophoneAudioContext[] = []
  readonly sampleRate: number
  state: 'running' | 'closed' = 'running'
  closed = false
  processor: {
    bufferSize: number
    onaudioprocess: ((event: any) => void) | undefined
    connect: jest.Mock
    disconnect: jest.Mock
  } | undefined
  source: { connect: jest.Mock; disconnect: jest.Mock } | undefined
  gain: { gain: { value: number }; connect: jest.Mock; disconnect: jest.Mock } | undefined
  readonly destination = {}
  constructor(sampleRate: number) {
    this.sampleRate = sampleRate
    FakeMicrophoneAudioContext.instances.push(this)
  }
  createMediaStreamSource() {
    this.source = { connect: jest.fn(), disconnect: jest.fn() }
    return this.source
  }
  createScriptProcessor(bufferSize: number) {
    this.processor = { bufferSize, onaudioprocess: undefined, connect: jest.fn(), disconnect: jest.fn() }
    return this.processor
  }
  createGain() {
    this.gain = { gain: { value: 1 }, connect: jest.fn(), disconnect: jest.fn() }
    return this.gain
  }
  async resume() { this.state = 'running' }
  async close() { this.closed = true; this.state = 'closed' }
}

const fetchCalls: { url: string, init: any }[] = []

function fakeVideo() {
  const video: any = new FakeEventTarget()
  video.videoWidth = 1280
  video.videoHeight = 720
  video.srcObject = null
  video.play = jest.fn()
  return video as HTMLVideoElement & FakeEventTarget
}

function stripeImageData(token: string): ImageData {
  const crc = crc16(Uint8Array.from([token.charCodeAt(0), token.charCodeAt(1)]))
  const payload = [token.charCodeAt(0), token.charCodeAt(1), (crc >> 8) & 0xff, crc & 0xff]
  const bits: number[] = []
  for (const byte of payload) {
    for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1)
  }
  const data = new Uint8ClampedArray(64 * 8 * 4)
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 16; col++) {
      const bit = bits[row * 16 + col]
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          const value = bit ? 235 : 16
          const i = ((row * 4 + y) * 64 + col * 4 + x) * 4
          data[i] = data[i + 1] = data[i + 2] = value
          data[i + 3] = 255
        }
      }
    }
  }
  return { data, width: 64, height: 8 } as ImageData
}

const logger = createLogger({
  debug: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
})

function createConfig(overrides: Record<string, any> = {}) {
  return {
    sessionId: 'unused',
    audioInput: false,
    videoId: 'xiaomai',
    frameRate: 25,
    rtcConfiguration: {},
    reconnectInterval: 0,
    connectTimeout: 0,
    maxAudioVideoDurationDifference: 0,
    pingInterval: 0,
    pingTimeout: 0,
    voiceClient: { url: 'ws://client:8300', sessionId: 'voice-1', ...overrides.voiceClient },
    ...overrides,
  } as any
}

function setupGlobals() {
  const originalWebSocket = (globalThis as any).WebSocket
  const originalPc = (globalThis as any).RTCPeerConnection
  const originalFetch = (globalThis as any).fetch
  const originalRequester = hooks.dh2d.createAvatarFrameRequester
  const originalSampler = hooks.dh2d.createAvatarFrameSampler
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const originalAudioContext = (globalThis as any).AudioContext
  FakeWebSocket.instances = []
  FakeRTCPeerConnection.instances = []
  FakeMicrophoneStream.instances = []
  FakeMicrophoneAudioContext.instances = []
  fetchCalls.length = 0
  let frameCallback: (() => void) | undefined
  let sampledImage: ImageData | null = null
  let microphoneSampleRate = 16000
  let getUserMedia: jest.Mock = jest.fn(async () => new FakeMicrophoneStream())
  ;(globalThis as any).WebSocket = FakeWebSocket
  ;(globalThis as any).RTCPeerConnection = FakeRTCPeerConnection
  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: { getUserMedia: (...args: any[]) => getUserMedia(...args) } },
    writable: true,
    configurable: true,
  })
  ;(globalThis as any).AudioContext = class extends FakeMicrophoneAudioContext {
    constructor() {
      super(microphoneSampleRate)
    }
  }
  ;(globalThis as any).fetch = async (url: any, init: any) => {
    fetchCalls.push({ url: String(url), init })
    return { json: async () => ({ type: 'answer', sdp: 'answer-sdp' }) }
  }
  hooks.dh2d.createAvatarFrameRequester = () => onFrame => {
    frameCallback = onFrame
    return () => { frameCallback = undefined }
  }
  hooks.dh2d.createAvatarFrameSampler = () => () => sampledImage
  const emitFrame = () => frameCallback?.()
  const setSample = (token: string | null) => { sampledImage = token ? stripeImageData(token) : null }
  const triggerMicrophone = (samples: Float32Array) => {
    const context = FakeMicrophoneAudioContext.instances[FakeMicrophoneAudioContext.instances.length - 1]
    context.processor!.onaudioprocess!({
      inputBuffer: { getChannelData: () => samples },
    })
  }
  const setMicrophoneSampleRate = (rate: number) => { microphoneSampleRate = rate }
  const setGetUserMedia = (mock: jest.Mock) => { getUserMedia = mock }
  const restore = () => {
    (globalThis as any).WebSocket = originalWebSocket
    ;(globalThis as any).RTCPeerConnection = originalPc
    ;(globalThis as any).fetch = originalFetch
    ;(globalThis as any).AudioContext = originalAudioContext
    if (originalNavigator) {
      Object.defineProperty(globalThis, 'navigator', originalNavigator)
    }
    hooks.dh2d.createAvatarFrameRequester = originalRequester
    hooks.dh2d.createAvatarFrameSampler = originalSampler
  }
  return {
    emitFrame, setSample, triggerMicrophone, setMicrophoneSampleRate, setGetUserMedia, restore,
  }
}

const flushMicrotasks = async (times = 8) => {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
  }
}

async function connectReady(config: any, video: any) {
  const scope = abortable()
  const connecting = withChild(scope, child => connectVoiceClient(logger, { video }, config, child))
  await flushMicrotasks()
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
  ws.open()
  await flushMicrotasks()
  ws.receive(JSON.stringify({ type: 'dh_2d_session_ready', session_id: 'canonical-avatar' }))
  await flushMicrotasks()
  const pc = FakeRTCPeerConnection.instances[FakeRTCPeerConnection.instances.length - 1]
  pc.dispatch('track', { track: { kind: 'video' }, streams: [{ id: 's' }] })
  pc.dispatch('track', { track: { kind: 'audio' }, streams: [{ id: 's' }] })
  video.dispatch('canplay')
  const connection = await connecting
  return { connection, ws, pc, scope }
}

describe('connectVoiceClient', () => {
  test('opens the client voice websocket with mode=avatar and video_id', async () => {
    const globals = setupGlobals()
    try {
      const video = fakeVideo()
      const { ws } = await connectReady(createConfig(), video)
      expect(ws.url).toBe('ws://client:8300/ws?mode=avatar&video_id=xiaomai')
    } finally {
      globals.restore()
    }
  })

  test('accepts a full client websocket URL with its own path', async () => {
    const globals = setupGlobals()
    try {
      const video = fakeVideo()
      const { ws } = await connectReady(createConfig({ voiceClient: { url: 'ws://client:8300/voice', sessionId: 'voice-1' } }), video)
      expect(ws.url).toBe('ws://client:8300/voice?mode=avatar&video_id=xiaomai')
    } finally {
      globals.restore()
    }
  })

  test('waits for the websocket OPEN before sending the session handshake', async () => {
    const globals = setupGlobals()
    const scope = abortable()
    try {
      const video = fakeVideo()
      const connecting = withChild(scope, child => connectVoiceClient(logger, { video }, createConfig(), child))
      await flushMicrotasks()
      const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
      expect(ws.readyState).toBe(FakeWebSocket.CONNECTING)
      // A premature send throws on the native websocket, so nothing may be
      // sent before OPEN; a premature send also leaves no sent frames.
      expect(ws.sent).toEqual([])
      ws.open()
      await flushMicrotasks()
      expect(ws.prematureSends).toEqual([])
      expect(ws.sent.map((d: string) => JSON.parse(d))).toEqual([
        { type: 'session.start', session_id: 'voice-1', protocol_version: 2 },
      ])
      ws.receive(JSON.stringify({ type: 'dh_2d_session_ready', session_id: 'canonical-avatar' }))
      await flushMicrotasks()
      const pc = FakeRTCPeerConnection.instances[FakeRTCPeerConnection.instances.length - 1]
      pc.dispatch('track', { track: { kind: 'video' }, streams: [{ id: 's' }] })
      pc.dispatch('track', { track: { kind: 'audio' }, streams: [{ id: 's' }] })
      video.dispatch('canplay')
      const connection = await connecting
      await disconnectVoiceClient(logger, connection, { video }, abortable())
    } finally {
      scope.abort()
      globals.restore()
    }
  })

  test('sends session.start with protocol version 2 and never opens a DH2D command websocket', async () => {
    const globals = setupGlobals()
    try {
      const video = fakeVideo()
      const { ws } = await connectReady(createConfig(), video)
      expect(JSON.parse(ws.sent[0])).toEqual({
        type: 'session.start', session_id: 'voice-1', protocol_version: 2,
      })
      expect(FakeWebSocket.instances.map(_ => _.url)).toEqual([
        'ws://client:8300/ws?mode=avatar&video_id=xiaomai',
      ])
    } finally {
      globals.restore()
    }
  })

  test('preserves the configured connectTimeout so a stalled attempt cannot hang', async () => {
    jest.useFakeTimers()
    const globals = setupGlobals()
    const scope = abortable()
    try {
      const video = fakeVideo()
      const config = createConfig({ connectTimeout: 50 })
      const connecting = withChild(scope, child => connectVoiceClient(logger, { video }, config, child))
      await flushMicrotasks()
      const first = FakeWebSocket.instances[0]
      first.open()
      await flushMicrotasks()
      // The socket is open but dh_2d_session_ready never arrives: the
      // attempt must fail on the configured timeout instead of hanging.
      jest.advanceTimersByTime(51)
      await flushMicrotasks()
      // The failure follows the standard retry backoff with a second attempt.
      jest.advanceTimersByTime(2000)
      await flushMicrotasks()
      expect(FakeWebSocket.instances.length).toBe(2)
      scope.abort()
      await expect(connecting).rejects.toThrow('connection aborted')
    } finally {
      jest.useRealTimers()
      scope.abort()
      globals.restore()
    }
  })

  test('a microphone acquisition failure fails the connection attempt and retries', async () => {
    jest.useFakeTimers()
    const globals = setupGlobals()
    globals.setGetUserMedia(jest.fn()
      .mockRejectedValueOnce(new Error('no microphone'))
      .mockResolvedValue(new FakeMicrophoneStream()))
    const scope = abortable()
    try {
      const video = fakeVideo()
      const config = createConfig({ audioInput: true })
      const connecting = withChild(scope, child => connectVoiceClient(logger, { video }, config, child))
      await flushMicrotasks()
      expect(FakeWebSocket.instances.length).toBe(1)
      jest.advanceTimersByTime(2000)
      await flushMicrotasks()
      expect(FakeWebSocket.instances.length).toBe(2)
      scope.abort()
      await expect(connecting).rejects.toThrow('connection aborted')
    } finally {
      jest.useRealTimers()
      scope.abort()
      globals.restore()
    }
  })

  test('exchanges the offer directly with the canonical DH2D session', async () => {
    const globals = setupGlobals()
    try {
      const video = fakeVideo()
      const { connection, pc } = await connectReady(createConfig(), video)
      expect(connection.sessionId).toBe('canonical-avatar')
      expect(pc.transceivers).toEqual([
        { kind: 'video', direction: 'recvonly' },
        { kind: 'audio', direction: 'recvonly' },
      ])
      expect(fetchCalls).toEqual([{
        url: 'http://localhost:32101/api/v1/session/canonical-avatar/offer',
        init: expect.objectContaining({ method: 'POST' }),
      }])
      expect(pc.remoteDescription).toEqual({ type: 'answer', sdp: 'answer-sdp' })
      expect(video.srcObject).toEqual({ id: 's' })
    } finally {
      globals.restore()
    }
  })

  test('adapts client events to app messages and binary frames to audio events', async () => {
    const globals = setupGlobals()
    try {
      const video = fakeVideo()
      const { connection, ws } = await connectReady(createConfig(), video)
      const messages: any[] = []
      const audio: any[] = []
      connection.on('message', m => messages.push(m))
      connection.on('audio', a => audio.push(a))
      ws.receive(JSON.stringify({ type: 'capture.start', session_id: 'voice-1', turn_id: 't1' }))
      ws.receive(JSON.stringify({ type: 'assistant.text', session_id: 'voice-1', turn_id: 't1', text: 'hi' }))
      ws.receive(JSON.stringify({ type: 'audio.chunk', session_id: 'voice-1', turn_id: 't1', subtitles: [{ source: 'main', text: 'spoken' }] }))
      ws.receive(new ArrayBuffer(8))
      expect(messages).toEqual([
        { type: 'status_change', status: 'listening' },
        { type: 'bot_output', text: 'hi' },
        { type: 'audio_text', text: 'spoken' },
      ])
      expect(audio).toEqual([expect.any(ArrayBuffer)])
    } finally {
      globals.restore()
    }
  })

  test('events for other voice sessions are not adapted', async () => {
    const globals = setupGlobals()
    try {
      const video = fakeVideo()
      const { connection, ws } = await connectReady(createConfig(), video)
      const messages: any[] = []
      connection.on('message', m => messages.push(m))
      ws.receive(JSON.stringify({ type: 'assistant.text', session_id: 'voice-2', turn_id: 't1', text: 'hi' }))
      expect(messages).toEqual([])
    } finally {
      globals.restore()
    }
  })

  test('connects without playback decoding when requestVideoFrameCallback is unavailable', async () => {
    const globals = setupGlobals()
    const originalRequester = hooks.dh2d.createAvatarFrameRequester
    hooks.dh2d.createAvatarFrameRequester = () => null as any
    try {
      const video = fakeVideo()
      const { connection } = await connectReady(createConfig(), video)
      expect(connection.sessionId).toBe('canonical-avatar')
      expect(typeof connection.stopPlayback).toBe('function')
      connection.stopPlayback()
    } finally {
      hooks.dh2d.createAvatarFrameRequester = originalRequester
      globals.restore()
    }
  })

  test('a validated stripe transition sends playback.ended for the previous turn', async () => {
    const globals = setupGlobals()
    try {
      const video = fakeVideo()
      const { ws } = await connectReady(createConfig(), video)
      globals.setSample('A0')
      globals.emitFrame()
      globals.setSample('A0')
      globals.emitFrame()
      globals.setSample(null)
      globals.emitFrame()
      globals.setSample('A1')
      globals.emitFrame()
      const playbackFrames = ws.sent.map((d: string) => JSON.parse(d)).filter((m: any) => m.type === 'playback.ended')
      expect(playbackFrames).toEqual([
        { type: 'playback.ended', session_id: 'voice-1', turn_id: 'A0' },
      ])
    } finally {
      globals.restore()
    }
  })

  test('an explicit playback.stop lifecycle signal ends the current turn without stripe evidence', async () => {
    const globals = setupGlobals()
    try {
      const video = fakeVideo()
      const { ws } = await connectReady(createConfig(), video)
      globals.setSample('A0')
      globals.emitFrame()
      // DH2D idle frames are undecodable, so the A-to-idle boundary comes
      // from the explicit protocol lifecycle signal naming the tracked
      // turn, never from frames.
      ws.receive(JSON.stringify({ type: 'playback.stop', session_id: 'voice-1', turn_id: 'A0' }))
      let playbackFrames = ws.sent.map((d: string) => JSON.parse(d)).filter((m: any) => m.type === 'playback.ended')
      expect(playbackFrames).toEqual([
        { type: 'playback.ended', session_id: 'voice-1', turn_id: 'A0' },
      ])
      ws.receive(JSON.stringify({ type: 'playback.stop', session_id: 'voice-1', turn_id: 'A0' }))
      globals.setSample(null)
      globals.emitFrame()
      playbackFrames = ws.sent.map((d: string) => JSON.parse(d)).filter((m: any) => m.type === 'playback.ended')
      expect(playbackFrames).toEqual([
        { type: 'playback.ended', session_id: 'voice-1', turn_id: 'A0' },
      ])
    } finally {
      globals.restore()
    }
  })

  test('a playback.stop for a retired turn never retires the currently tracked turn', async () => {
    const globals = setupGlobals()
    try {
      const video = fakeVideo()
      const { ws } = await connectReady(createConfig(), video)
      globals.setSample('A0')
      globals.emitFrame()
      globals.setSample('A1')
      globals.emitFrame()
      // The stripe transition retired A0 and the tracker now holds A1; a
      // late stop still targeting A0 must not retire A1.
      ws.receive(JSON.stringify({ type: 'playback.stop', session_id: 'voice-1', turn_id: 'A0' }))
      let playbackFrames = ws.sent.map((d: string) => JSON.parse(d)).filter((m: any) => m.type === 'playback.ended')
      expect(playbackFrames).toEqual([
        { type: 'playback.ended', session_id: 'voice-1', turn_id: 'A0' },
      ])
      ws.receive(JSON.stringify({ type: 'playback.stop', session_id: 'voice-1', turn_id: 'A1' }))
      playbackFrames = ws.sent.map((d: string) => JSON.parse(d)).filter((m: any) => m.type === 'playback.ended')
      expect(playbackFrames).toEqual([
        { type: 'playback.ended', session_id: 'voice-1', turn_id: 'A0' },
        { type: 'playback.ended', session_id: 'voice-1', turn_id: 'A1' },
      ])
    } finally {
      globals.restore()
    }
  })

  test('a playback.stop for a queued turn never retires the currently tracked turn', async () => {
    const globals = setupGlobals()
    try {
      const video = fakeVideo()
      const { ws } = await connectReady(createConfig(), video)
      globals.setSample('A0')
      globals.emitFrame()
      // A stop naming a turn that is not the tracked one (for example a
      // queued turn) must not end the tracked turn's playback.
      ws.receive(JSON.stringify({ type: 'playback.stop', session_id: 'voice-1', turn_id: 'B2' }))
      let playbackFrames = ws.sent.map((d: string) => JSON.parse(d)).filter((m: any) => m.type === 'playback.ended')
      expect(playbackFrames).toEqual([])
      ws.receive(JSON.stringify({ type: 'playback.stop', session_id: 'voice-1', turn_id: 'A0' }))
      playbackFrames = ws.sent.map((d: string) => JSON.parse(d)).filter((m: any) => m.type === 'playback.ended')
      expect(playbackFrames).toEqual([
        { type: 'playback.ended', session_id: 'voice-1', turn_id: 'A0' },
      ])
    } finally {
      globals.restore()
    }
  })

  test('a playback.stop for another voice session is ignored', async () => {
    const globals = setupGlobals()
    try {
      const video = fakeVideo()
      const { ws } = await connectReady(createConfig(), video)
      globals.setSample('A0')
      globals.emitFrame()
      ws.receive(JSON.stringify({ type: 'playback.stop', session_id: 'voice-2', turn_id: 'A0' }))
      let playbackFrames = ws.sent.map((d: string) => JSON.parse(d)).filter((m: any) => m.type === 'playback.ended')
      expect(playbackFrames).toEqual([])
      ws.receive(JSON.stringify({ type: 'playback.stop', session_id: 'voice-1', turn_id: 'A0' }))
      playbackFrames = ws.sent.map((d: string) => JSON.parse(d)).filter((m: any) => m.type === 'playback.ended')
      expect(playbackFrames).toEqual([
        { type: 'playback.ended', session_id: 'voice-1', turn_id: 'A0' },
      ])
    } finally {
      globals.restore()
    }
  })

  test('a playback.stop without a turn id still ends the tracked turn', async () => {
    const globals = setupGlobals()
    try {
      const video = fakeVideo()
      const { ws } = await connectReady(createConfig(), video)
      globals.setSample('A0')
      globals.emitFrame()
      ws.receive(JSON.stringify({ type: 'playback.stop', session_id: 'voice-1' }))
      const playbackFrames = ws.sent.map((d: string) => JSON.parse(d)).filter((m: any) => m.type === 'playback.ended')
      expect(playbackFrames).toEqual([
        { type: 'playback.ended', session_id: 'voice-1', turn_id: 'A0' },
      ])
    } finally {
      globals.restore()
    }
  })
})

describe('voice-client microphone input', () => {
  test('no microphone is opened when audio input is disabled', async () => {
    const globals = setupGlobals()
    try {
      const video = fakeVideo()
      await connectReady(createConfig(), video)
      expect(FakeMicrophoneAudioContext.instances.length).toBe(0)
    } finally {
      globals.restore()
    }
  })

  test('sends microphone PCM as audio.chunk control followed by binary only during capture', async () => {
    const globals = setupGlobals()
    try {
      const video = fakeVideo()
      const { ws } = await connectReady(createConfig({ audioInput: true }), video)
      globals.triggerMicrophone(new Float32Array([0, 0.5, -0.5, 1]))
      // Without an accepted capture turn nothing is sent.
      expect(ws.sent.length).toBe(1)
      ws.receive(JSON.stringify({ type: 'capture.start', session_id: 'voice-1', turn_id: 't1' }))
      globals.triggerMicrophone(new Float32Array([0, 0.5, -0.5, 1]))
      expect(ws.sent.length).toBe(3)
      expect(JSON.parse(ws.sent[1])).toEqual({
        type: 'audio.chunk', direction: 'input',
        session_id: 'voice-1', turn_id: 't1', byte_count: 8,
      })
      expect(ws.sent[2]).toBeInstanceOf(Uint8Array)
      expect(Array.from(ws.sent[2] as Uint8Array)).toEqual([0, 0, 0, 0x40, 0x01, 0xc0, 0xff, 0x7f])
      ws.receive(JSON.stringify({ type: 'capture.stop', session_id: 'voice-1', turn_id: 't1' }))
      globals.triggerMicrophone(new Float32Array([0.5]))
      expect(ws.sent.length).toBe(3)
    } finally {
      globals.restore()
    }
  })

  test('resamples the microphone to 16 kHz PCM16', async () => {
    const globals = setupGlobals()
    try {
      const video = fakeVideo()
      globals.setMicrophoneSampleRate(48000)
      const { ws } = await connectReady(createConfig({ audioInput: true }), video)
      ws.receive(JSON.stringify({ type: 'capture.start', session_id: 'voice-1', turn_id: 't1' }))
      globals.triggerMicrophone(new Float32Array([0, 9, 9, 0.5, 9, 9]))
      expect(ws.sent.length).toBe(3)
      expect(JSON.parse(ws.sent[1])).toEqual({
        type: 'audio.chunk', direction: 'input',
        session_id: 'voice-1', turn_id: 't1', byte_count: 4,
      })
      expect(Array.from(ws.sent[2] as Uint8Array)).toEqual([0, 0, 0, 0x40])
    } finally {
      globals.restore()
    }
  })

  test('uses a provided MediaStream without getUserMedia and keeps its tracks alive on disconnect', async () => {
    const globals = setupGlobals()
    try {
      const video = fakeVideo()
      const stream = new FakeMicrophoneStream()
      const { connection } = await connectReady(
        createConfig({ audioInput: stream as unknown as MediaStream }), video)
      await disconnectVoiceClient(logger, connection, { video }, abortable())
      expect(stream.audioTracks[0].stop).not.toHaveBeenCalled()
      expect(FakeMicrophoneAudioContext.instances[0].closed).toBe(true)
    } finally {
      globals.restore()
    }
  })

  test('stops the acquired microphone stream on disconnect', async () => {
    const globals = setupGlobals()
    try {
      const video = fakeVideo()
      const { connection } = await connectReady(createConfig({ audioInput: true }), video)
      const stream = FakeMicrophoneStream.instances[0]
      await disconnectVoiceClient(logger, connection, { video }, abortable())
      expect(stream.audioTracks[0].stop).toHaveBeenCalled()
      expect(FakeMicrophoneAudioContext.instances[0].closed).toBe(true)
    } finally {
      globals.restore()
    }
  })
})

describe('sendVoiceClientMessage', () => {
  function setup() {
    const ws = new FakeWebSocket('ws://client:8300/ws')
    ws.open()
    const adapter = createVoiceMessageAdapter({ sessionId: 'voice-1' })
    return { ws, adapter }
  }

  test('wakeup while inactive sends conversation.start only', async () => {
    const { ws, adapter } = setup()
    await sendVoiceClientMessage(ws as any, adapter, { type: 'wakeup' })
    expect(ws.sent.map((d: string) => JSON.parse(d))).toEqual([
      { type: 'conversation.start', session_id: 'voice-1' },
    ])
  })

  test('sleep sends conversation.stop', async () => {
    const { ws, adapter } = setup()
    await sendVoiceClientMessage(ws as any, adapter, { type: 'sleep' })
    expect(ws.sent.map((d: string) => JSON.parse(d))).toEqual([
      { type: 'conversation.stop', session_id: 'voice-1' },
    ])
  })

  test('text input sends text.input with request_id', async () => {
    const { ws, adapter } = setup()
    await sendVoiceClientMessage(ws as any, adapter, { type: 'input', text: 'hello' })
    const frame = JSON.parse(ws.sent[0])
    expect(frame.type).toBe('text.input')
    expect(frame.text).toBe('hello')
    expect(typeof frame.request_id).toBe('string')
  })

  test('input with bot_text is rejected instead of silently dropped', async () => {
    const { ws, adapter } = setup()
    await expect(sendVoiceClientMessage(ws as any, adapter, {
      type: 'input', bot_text: 'I will say exactly this text.',
    })).rejects.toThrow(/bot_text/)
    expect(ws.sent).toEqual([])
  })

  test('input with text and bot_text sends no frame before failing', async () => {
    const { ws, adapter } = setup()
    await expect(sendVoiceClientMessage(ws as any, adapter, {
      type: 'input', text: 'hello', bot_text: 'verbatim',
    })).rejects.toThrow(/bot_text/)
    expect(ws.sent).toEqual([])
  })

  test('asr_session start maps to conversation.start', async () => {
    const { ws, adapter } = setup()
    await sendVoiceClientMessage(ws as any, adapter, { type: 'asr_session', command: 'start' })
    expect(ws.sent.map((d: string) => JSON.parse(d))).toEqual([
      { type: 'conversation.start', session_id: 'voice-1' },
    ])
  })

  test('asr_session stop maps to conversation.stop', async () => {
    const { ws, adapter } = setup()
    await sendVoiceClientMessage(ws as any, adapter, { type: 'asr_session', command: 'stop' })
    expect(ws.sent.map((d: string) => JSON.parse(d))).toEqual([
      { type: 'conversation.stop', session_id: 'voice-1' },
    ])
  })

  test('asr_session with should_respond true maps to conversation lifecycle', async () => {
    const { ws, adapter } = setup()
    await sendVoiceClientMessage(ws as any, adapter, {
      type: 'asr_session', command: 'start', should_respond: true,
    })
    expect(ws.sent.map((d: string) => JSON.parse(d))).toEqual([
      { type: 'conversation.start', session_id: 'voice-1' },
    ])
  })

  test('asr_session with should_respond false is rejected instead of silently dropped', async () => {
    const { ws, adapter } = setup()
    await expect(sendVoiceClientMessage(ws as any, adapter, {
      type: 'asr_session', command: 'start', should_respond: false,
    })).rejects.toThrow(/should_respond/)
    expect(ws.sent).toEqual([])
  })

  test('asr_session with an unknown command is rejected', async () => {
    const { ws, adapter } = setup()
    await expect(sendVoiceClientMessage(ws as any, adapter, {
      type: 'asr_session', command: 'nonsense' as any,
    })).rejects.toThrow(/asr_session/)
    expect(ws.sent).toEqual([])
  })

  test('config and ping frames are ignored', async () => {
    const { ws, adapter } = setup()
    await sendVoiceClientMessage(ws as any, adapter, { type: 'config' } as any)
    await sendVoiceClientMessage(ws as any, adapter, { type: 'ping', timestamp: 'now' } as any)
    expect(ws.sent).toEqual([])
  })
})

describe('disconnectVoiceClient', () => {
  test('stops playback watching and closes the connections', async () => {
    const globals = setupGlobals()
    try {
      const video = fakeVideo()
      const { connection, ws, pc } = await connectReady(createConfig(), video)
      globals.setSample('A0')
      globals.emitFrame()
      await disconnectVoiceClient(logger, connection, { video }, abortable())
      globals.setSample('A1')
      globals.emitFrame()
      const playbackFrames = ws.sent.map((d: string) => JSON.parse(d)).filter((m: any) => m.type === 'playback.ended')
      expect(playbackFrames).toEqual([])
      expect(ws.closed).toBe(true)
      expect(pc.closed).toBe(true)
    } finally {
      globals.restore()
    }
  })

  test('fences stale connection callbacks, drops queued events, and clears the video source', async () => {
    const globals = setupGlobals()
    try {
      const video = fakeVideo()
      const { connection, ws } = await connectReady(createConfig(), video)
      const messages: any[] = []
      const audio: any[] = []
      connection.on('message', m => messages.push(m))
      connection.on('audio', a => audio.push(a))
      expect(video.srcObject).toEqual({ id: 's' })
      await disconnectVoiceClient(logger, connection, { video }, abortable())
      // Late traffic from the retired connection must never reach the app.
      ws.receive(JSON.stringify({ type: 'assistant.text', session_id: 'voice-1', turn_id: 't1', text: 'late' }))
      ws.receive(new ArrayBuffer(8))
      globals.setSample('B2')
      globals.emitFrame()
      expect(messages).toEqual([])
      expect(audio).toEqual([])
      expect(video.srcObject).toBeNull()
    } finally {
      globals.restore()
    }
  })
})
