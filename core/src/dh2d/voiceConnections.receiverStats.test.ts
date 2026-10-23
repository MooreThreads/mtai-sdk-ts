import { abortable, withChild } from '../abortable'
import { createLogger } from '../log'
import { hooks } from '../hooks'
import { setConfig } from '../config'
import { connectVoiceClient } from './voiceConnections'

jest.mock('./receiverStats', () => ({
  createReceiverStats: jest.fn(() => ({ request: jest.fn(), stop: jest.fn() })),
}))

class Target {
  listeners = new Map<string, Set<(event?: any) => void>>()
  addEventListener(name: string, listener: (event?: any) => void) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name)!.add(listener) }
  removeEventListener(name: string, listener: (event?: any) => void) { this.listeners.get(name)?.delete(listener) }
  dispatch(name: string, event: any = {}) { this.listeners.get(name)?.forEach(listener => listener(event)) }
}
class Ws {
  static instances: Ws[] = []
  static OPEN = 1
  static CONNECTING = 0
  readyState = Ws.CONNECTING
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: any) => void) | null = null
  sent: string[] = []
  constructor(readonly url: string) { Ws.instances.push(this) }
  open() { this.readyState = Ws.OPEN; this.onopen?.() }
  send(data: string) { this.sent.push(data) }
  close() { this.onclose?.() }
  receive(data: string) { this.onmessage?.({ data }) }
}
class Pc extends Target {
  static instances: Pc[] = []
  iceGatheringState = 'complete'
  localDescription = { type: 'offer', sdp: 'offer' }
  constructor() { super(); Pc.instances.push(this) }
  addTransceiver() { }
  async createOffer() { return this.localDescription }
  async setLocalDescription() { }
  async setRemoteDescription() { }
  close() { }
}

function config() {
  return { sessionId: 'unused', audioInput: false, videoId: 'avatar', frameRate: 25,
    rtcConfiguration: {}, reconnectInterval: 0, connectTimeout: 0,
    maxAudioVideoDurationDifference: 0, pingInterval: 0, pingTimeout: 0,
    voiceClient: { interaction_endpoint: 'ws://client:8300', dh2d_endpoint: 'http://dh2d:32107', sessionId: 'voice-1' } } as any
}
function validStripe(token: string): ImageData {
  const data = new Uint8ClampedArray(64 * 8 * 4).fill(128)
  const bytes = [token.charCodeAt(0), token.charCodeAt(1)]
  let crc = 0xffff
  for (const byte of bytes) { crc ^= byte << 8; for (let bit = 0; bit < 8; bit++) crc = (crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1; crc &= 0xffff }
  const payload = [...bytes, crc >> 8, crc & 0xff]
  const bits = payload.flatMap(byte => Array.from({ length: 8 }, (_, index) => (byte >> (7 - index)) & 1))
  for (let row = 0; row < 2; row++) for (let col = 0; col < 16; col++) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    const value = bits[row * 16 + col] ? 235 : 16
    const index = ((row * 4 + y) * 64 + col * 4 + x) * 4
    data[index] = data[index + 1] = data[index + 2] = value; data[index + 3] = 255
  }
  return { data, width: 64, height: 8 } as ImageData
}

 test('integrates ready baseline, asynchronous changed-token sampling, and public retirement', async () => {
  const originalWs = (globalThis as any).WebSocket
  const originalPc = (globalThis as any).RTCPeerConnection
  const originalFetch = (globalThis as any).fetch
  const originalRequester = hooks.dh2d.createAvatarFrameRequester
  const originalSampler = hooks.dh2d.createAvatarFrameSampler
  const receiverModule = require('./receiverStats') as { createReceiverStats: jest.Mock }
  let callback: ((now?: number, metadata?: any) => void) | undefined
  let image = validStripe('A0')
  try {
    Ws.instances = []; Pc.instances = []
    ;(globalThis as any).WebSocket = Ws
    ;(globalThis as any).RTCPeerConnection = Pc
    ;(globalThis as any).fetch = async () => ({ json: async () => ({ type: 'answer', sdp: 'answer' }) })
    hooks.dh2d.createAvatarFrameRequester = () => onFrame => { callback = onFrame; return () => { callback = undefined } }
    hooks.dh2d.createAvatarFrameSampler = () => () => image
    setConfig({ endpoint: 'http://root:32101' } as any)
    const video = Object.assign(new Target(), { videoWidth: 64, videoHeight: 8, srcObject: null, play: jest.fn() })
    const scope = abortable()
    const connecting = withChild(scope, child => connectVoiceClient(createLogger({ log: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined }), { video } as any, config(), child))
    await Promise.resolve(); const ws = Ws.instances[0]; ws.open(); await Promise.resolve()
    ws.receive(JSON.stringify({ type: 'dh_2d_session_ready', session_id: 'canonical' }))
    await Promise.resolve(); const pc = Pc.instances[0]
    pc.dispatch('track', { track: { kind: 'video' }, streams: [{}] }); pc.dispatch('track', { track: { kind: 'audio' }, streams: [{}] })
    video.dispatch('canplay')
    const connection = await connecting
    const collector = receiverModule.createReceiverStats.mock.results[0].value
    expect(collector.request).toHaveBeenCalledTimes(1)
    callback!(11, { rtpTimestamp: 77 })
    expect(collector.request).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    expect(collector.request).toHaveBeenCalledTimes(2)
    connection.stopPlayback()
    expect(collector.stop).toHaveBeenCalledTimes(1)
    connection.dispose()
    expect(collector.stop).toHaveBeenCalledTimes(2)
    scope.abort()
  } finally {
    ;(globalThis as any).WebSocket = originalWs; (globalThis as any).RTCPeerConnection = originalPc; (globalThis as any).fetch = originalFetch
    hooks.dh2d.createAvatarFrameRequester = originalRequester; hooks.dh2d.createAvatarFrameSampler = originalSampler
    receiverModule.createReceiverStats.mockClear()
  }
})
