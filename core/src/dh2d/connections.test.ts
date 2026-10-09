import { abortable } from '../abortable'
import { events } from '../events'
import { createLogger } from '../log'
import { untilFailed } from './connections'

class FakeMediaStream {
  getAudioTracks() {
    return [{}]
  }
}

class FakeEventTarget {
  private readonly listeners = new Map<string, Set<(_: any) => void>>()

  addEventListener(event: string, listener: (_: any) => void) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)!.add(listener)
  }

  dispatch(event: string, payload: any = {}) {
    this.listeners.get(event)?.forEach(listener => listener(payload))
  }
}

class FakeWebSocket extends FakeEventTarget {
  readonly send = jest.fn()
  readyState = 1
}

class FakePeerConnection extends FakeEventTarget {
  connectionState = 'connected'
  getStats = async () => ({})
}

const logger = createLogger({
  debug: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
})

const flushPromises = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

function createConnection(ws: FakeWebSocket, pc: FakePeerConnection, audioPc?: FakePeerConnection) {
  const evt = events<any>()
  return {
    sessionId: 'session-1',
    ws,
    pc,
    ...(audioPc ? { audioPc } : {}),
    on: evt.on,
    off: evt.off,
  }
}

function createConfig() {
  return {
    sessionId: 'session-1',
    audioInput: false,
    videoId: 'demo',
    frameRate: 25,
    rtcConfiguration: {},
    reconnectInterval: 0,
    connectTimeout: 0,
    maxAudioVideoDurationDifference: 0,
    pingInterval: 0,
    pingTimeout: 0,
  }
}

function sentTypes(ws: FakeWebSocket) {
  return ws.send.mock.calls.map(([data]: [string]) => {
    try {
      return JSON.parse(data).type
    } catch {
      return data
    }
  })
}

describe('untilFailed without audio activity monitoring', () => {
  const originalWindow = (globalThis as any).window
  const originalMediaStream = (globalThis as any).MediaStream
  const originalAudioContext = (globalThis as any).AudioContext

  beforeEach(() => {
    jest.useFakeTimers()
    ;(globalThis as any).window = globalThis
    ;(globalThis as any).MediaStream = FakeMediaStream
  })

  afterEach(() => {
    jest.useRealTimers()
    ;(globalThis as any).window = originalWindow
    ;(globalThis as any).MediaStream = originalMediaStream
    ;(globalThis as any).AudioContext = originalAudioContext
  })

  test('never starts an AudioContext or reports dh_2d_audio_activity on a direct DH2D connection', async () => {
    const audioContextConstructed = jest.fn()
    ;(globalThis as any).window.AudioContext = audioContextConstructed

    const ws = new FakeWebSocket()
    const connection = createConnection(ws, new FakePeerConnection())
    const scope = abortable()

    const untilStopped = untilFailed(
      logger,
      connection as any,
      { video: { srcObject: new FakeMediaStream() } } as any,
      createConfig() as any,
      scope,
    )

    await flushPromises()
    jest.advanceTimersByTime(1000)
    await flushPromises()

    expect(audioContextConstructed).not.toHaveBeenCalled()
    expect(sentTypes(ws)).not.toContain('dh_2d_audio_activity')

    ws.dispatch('close')
    await untilStopped
  })

  test('aborting the scope resolves untilFailed without sending diagnostics', async () => {
    const ws = new FakeWebSocket()
    const connection = createConnection(ws, new FakePeerConnection())
    const scope = abortable()

    const untilStopped = untilFailed(
      logger,
      connection as any,
      { video: {} } as any,
      createConfig() as any,
      scope,
    )

    await flushPromises()
    expect(ws.send).not.toHaveBeenCalled()

    scope.abort()
    await untilStopped
  })

  test('websocket close resolves untilFailed without aborting the caller scope', async () => {
    const ws = new FakeWebSocket()
    const connection = createConnection(ws, new FakePeerConnection())
    const scope = abortable()
    const onAbort = jest.fn()
    scope.onabort(onAbort)

    const untilStopped = untilFailed(
      logger,
      connection as any,
      { video: {} } as any,
      createConfig() as any,
      scope,
    )

    await flushPromises()
    ws.dispatch('close')
    await untilStopped

    expect(onAbort).not.toHaveBeenCalled()
  })

  test('keeps reporting dh_2d_stats played frames for direct connections without audio input', async () => {
    const ws = new FakeWebSocket()
    const pc = new FakePeerConnection()
    let framesReceived = 0
    ;(pc as any).getStats = async () => {
      framesReceived += 1
      return { 'inbound-video': { type: 'inbound-rtp', kind: 'video', framesReceived } }
    }
    const connection = createConnection(ws, pc, undefined)
    const scope = abortable()

    const untilStopped = untilFailed(
      logger,
      connection as any,
      { video: {} } as any,
      createConfig() as any,
      scope,
    )

    await flushPromises()
    jest.advanceTimersByTime(200)
    await flushPromises()

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'dh_2d_stats', played_frames: 1 }))

    ws.dispatch('close')
    await untilStopped
  })

  test('voice-client mode sends no stats or ping diagnostics on the interaction websocket', async () => {
    const ws = new FakeWebSocket()
    const pc = new FakePeerConnection()
    let framesReceived = 0
    ;(pc as any).getStats = async () => {
      framesReceived += 1
      return { 'inbound-video': { type: 'inbound-rtp', kind: 'video', framesReceived } }
    }
    const connection = createConnection(ws, pc, undefined)
    const scope = abortable()

    const untilStopped = untilFailed(
      logger,
      connection as any,
      { video: {} } as any,
      {
        ...createConfig(),
        pingInterval: 100,
        pingTimeout: 1000,
        voiceClient: { interaction_endpoint: 'ws://client:8300', dh2d_endpoint: 'http://dh2d-voice:32107' },
      } as any,
      scope,
    )

    await flushPromises()
    jest.advanceTimersByTime(1000)
    await flushPromises()

    expect(ws.send).not.toHaveBeenCalled()

    ws.dispatch('close')
    await untilStopped
  })
})
