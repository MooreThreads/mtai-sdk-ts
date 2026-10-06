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
  readonly url: string
  readonly sent: any[] = []
  onmessage: ((event: { data: any }) => void) | undefined
  closed = false
  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }
  send(data: any) { this.sent.push(data) }
  close() { this.closed = true }
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
  FakeWebSocket.instances = []
  FakeRTCPeerConnection.instances = []
  fetchCalls.length = 0
  let frameCallback: (() => void) | undefined
  let sampledImage: ImageData | null = null
  ;(globalThis as any).WebSocket = FakeWebSocket
  ;(globalThis as any).RTCPeerConnection = FakeRTCPeerConnection
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
  const restore = () => {
    ;(globalThis as any).WebSocket = originalWebSocket
    ;(globalThis as any).RTCPeerConnection = originalPc
    ;(globalThis as any).fetch = originalFetch
    hooks.dh2d.createAvatarFrameRequester = originalRequester
    hooks.dh2d.createAvatarFrameSampler = originalSampler
  }
  return { emitFrame, setSample, restore }
}

async function connectReady(config: any, video: any, frames: { emitFrame: () => void, setSample: (t: string | null) => void }) {
  const scope = abortable()
  const connecting = withChild(scope, child => connectVoiceClient(logger, { video }, config, child))
  await Promise.resolve()
  await Promise.resolve()
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
  ws.receive(JSON.stringify({ type: 'dh_2d_session_ready', session_id: 'canonical-avatar' }))
  await Promise.resolve()
  await Promise.resolve()
  const pc = FakeRTCPeerConnection.instances[FakeRTCPeerConnection.instances.length - 1]
  pc.dispatch('track', { track: { kind: 'video' }, streams: [{ id: 's' }] })
  pc.dispatch('track', { track: { kind: 'audio' }, streams: [{ id: 's' }] })
  video.dispatch('canplay')
  const connection = await connecting
  void frames
  return { connection, ws, pc }
}

describe('connectVoiceClient', () => {
  test('opens the client voice websocket with mode=avatar and video_id', async () => {
    const globals = setupGlobals()
    try {
      const video = fakeVideo()
      const { ws } = await connectReady(createConfig(), video, globals)
      expect(ws.url).toBe('ws://client:8300/ws?mode=avatar&video_id=xiaomai')
    } finally {
      globals.restore()
    }
  })

  test('accepts a full client websocket URL with its own path', async () => {
    const globals = setupGlobals()
    try {
      const video = fakeVideo()
      const { ws } = await connectReady(createConfig({ voiceClient: { url: 'ws://client:8300/voice', sessionId: 'voice-1' } }), video, globals)
      expect(ws.url).toBe('ws://client:8300/voice?mode=avatar&video_id=xiaomai')
    } finally {
      globals.restore()
    }
  })

  test('sends session.start with protocol version 2 and never opens a DH2D command websocket', async () => {
    const globals = setupGlobals()
    try {
      const video = fakeVideo()
      const { ws } = await connectReady(createConfig(), video, globals)
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

  test('exchanges the offer directly with the canonical DH2D session', async () => {
    const globals = setupGlobals()
    try {
      const video = fakeVideo()
      const { connection, pc } = await connectReady(createConfig(), video, globals)
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
      const { connection, ws } = await connectReady(createConfig(), video, globals)
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
      const { connection, ws } = await connectReady(createConfig(), video, globals)
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
      const { connection } = await connectReady(createConfig(), video, globals)
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
      const { ws } = await connectReady(createConfig(), video, globals)
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
})

describe('sendVoiceClientMessage', () => {
  function setup() {
    const ws = new FakeWebSocket('ws://client:8300/ws')
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

  test('config, ping and asr_session frames are ignored', async () => {
    const { ws, adapter } = setup()
    await sendVoiceClientMessage(ws as any, adapter, { type: 'config' } as any)
    await sendVoiceClientMessage(ws as any, adapter, { type: 'ping', timestamp: 'now' } as any)
    await sendVoiceClientMessage(ws as any, adapter, { type: 'asr_session', command: 'start' })
    expect(ws.sent).toEqual([])
  })
})

describe('disconnectVoiceClient', () => {
  test('stops playback watching and closes the connections', async () => {
    const globals = setupGlobals()
    try {
      const video = fakeVideo()
      const { connection, ws, pc } = await connectReady(createConfig(), video, globals)
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
})
