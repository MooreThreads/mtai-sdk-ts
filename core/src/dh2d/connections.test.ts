import { abortable } from '../abortable'
import { events } from '../events'
import { createLogger } from '../log'
import { connect, untilFailed } from './connections'
import { dh2dHooks } from './hooks'
import { setConfig } from '../config'

it('retires legacy attempt abort subscriptions across failed attempts and backoff', async () => {
  jest.useFakeTimers()
  const original = { WebSocket: globalThis.WebSocket, RTCPeerConnection: globalThis.RTCPeerConnection,
    document: (globalThis as any).document, window: (globalThis as any).window }
  const sockets: any[] = []
  ;(globalThis as any).WebSocket = class {
    onclose?: () => void
    close() {}
    constructor() { sockets.push(this) }
  }
  ;(globalThis as any).RTCPeerConnection = class {
    close() {}
    addEventListener() {}
    removeEventListener() {}
  }
  ;(globalThis as any).document = { createElement: () => {
    const image: any = {}
    Object.defineProperty(image, 'src', { set() { queueMicrotask(() => image.onerror?.()) }, get() { return 'blob:gc' } })
    return image
  } }
  ;(globalThis as any).window = { URL: { createObjectURL: () => 'blob:gc', revokeObjectURL: () => {} } }
  const root = abortable()
  const retained = new Set<() => void>()
  const scope = { abort: root.abort, onabort: (handler: () => void) => {
    retained.add(handler)
    const remove = root.onabort(handler)
    return () => { retained.delete(handler); remove() }
  } }
  const result = connect(logger, { video: { addEventListener() {}, removeEventListener() {} } } as any,
    createConfig(), scope).catch(error => error)
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(sockets).toHaveLength(attempt + 1)
      sockets[attempt].onclose()
      await jest.advanceTimersByTimeAsync(0)
      expect(retained.size).toBe(0)
      if (attempt < 2) await jest.advanceTimersByTimeAsync(2000)
    }
    root.abort()
    await jest.advanceTimersByTimeAsync(2000)
    expect(await result).toEqual(new Error('connection aborted'))
    expect(sockets).toHaveLength(3)
    expect(retained.size).toBe(0)
  } finally {
    root.abort()
    await jest.advanceTimersByTimeAsync(2000)
    await result
    Object.assign(globalThis, original)
    jest.useRealTimers()
  }
})

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
    emit: evt.emit,
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

  const voice = { interaction_endpoint: 'ws://client:8300', dh2d_endpoint: 'http://client:32106' }
  const interval = 20 * 60 * 1000

  test.each(['session', 'root'])('default %s voice mode retains a healthy peer across both age triggers', async source => {
    setConfig({ endpoint: 'http://localhost', voiceClient: source === 'root' ? voice : undefined })
    const connection = createConnection(new FakeWebSocket(), new FakePeerConnection())
    const scope = abortable()
    const stopped = jest.fn()
    const result = untilFailed(logger, connection as any, { video: {} } as any, {
      ...dh2dHooks.defaultConfig({ voiceClient: source === 'session' ? voice : undefined }),
      maxAudioVideoDurationDifference: 0,
    }, scope).then(stopped)
    try {
      await jest.advanceTimersByTimeAsync(interval + 1)
      expect(stopped).not.toHaveBeenCalled()
      connection.emit('message', { type: 'status_change', status: 'listening' })
      await flushPromises()
      expect(stopped).not.toHaveBeenCalled()
      connection.pc.connectionState = 'failed'
      connection.pc.dispatch('connectionstatechange')
      await result
      expect(stopped).toHaveBeenCalledTimes(1)
    } finally {
      scope.abort()
      await result
      setConfig({ endpoint: 'http://localhost', voiceClient: undefined })
    }
  })

  test.each([
    ['direct', 'timer'], ['direct', 'status'], ['explicit voice', 'timer'], ['explicit voice', 'status'],
  ])('%s age replacement still honors the %s trigger', async (mode, trigger) => {
    setConfig({ endpoint: 'http://localhost', voiceClient: undefined })
    const connection = createConnection(new FakeWebSocket(), new FakePeerConnection())
    const scope = abortable()
    const stopped = jest.fn()
    const configuredInterval = mode === 'direct' ? interval : 4 * 60 * 1000
    const result = untilFailed(logger, connection as any, { video: {} } as any, {
      ...dh2dHooks.defaultConfig(mode === 'direct' ? {} : { voiceClient: voice, reconnectInterval: configuredInterval }),
      maxAudioVideoDurationDifference: 0, pingInterval: 0,
    }, scope).then(stopped)
    try {
      if (trigger === 'status') connection.emit('message', { type: 'status_change', status: 'talking' })
      await jest.advanceTimersByTimeAsync(configuredInterval - 1)
      if (trigger === 'status') {
        connection.emit('message', { type: 'status_change', status: 'listening' })
        await jest.advanceTimersByTimeAsync(0)
        connection.emit('message', { type: 'status_change', status: 'talking' })
      }
      expect(stopped).not.toHaveBeenCalled()
      await jest.advanceTimersByTimeAsync(1)
      if (trigger === 'status') {
        await jest.advanceTimersByTimeAsync(1)
        expect(stopped).not.toHaveBeenCalled()
        connection.emit('message', { type: 'status_change', status: 'listening' })
      }
      await jest.advanceTimersByTimeAsync(0)
      expect(stopped).toHaveBeenCalledTimes(1)
    } finally {
      scope.abort()
      await result
    }
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
