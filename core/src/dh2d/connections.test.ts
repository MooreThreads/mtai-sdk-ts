import { abortable } from '../abortable'
import { events } from '../events'
import { createLogger } from '../log'
import { untilFailed } from './connections'

class FakeMediaStream {
  getAudioTracks() {
    return [{}]
  }
}

class FakeAnalyser {
  fftSize = 0

  disconnect() {}

  getFloatTimeDomainData(samples: Float32Array) {
    samples.fill(0.01)
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []

  state: 'suspended' | 'running' | 'closed' = 'suspended'
  readonly analyser = new FakeAnalyser()
  readonly source = {
    connect: () => undefined,
    disconnect: () => undefined,
  }

  constructor() {
    FakeAudioContext.instances.push(this)
  }

  createMediaStreamSource() {
    return this.source
  }

  createAnalyser() {
    return this.analyser
  }

  async resume() {
    this.state = 'running'
  }

  async close() {
    this.state = 'closed'
  }
}

class DeferredAudioContext extends FakeAudioContext {
  static instances: DeferredAudioContext[] = []
  private resumeResolver: (() => void) | undefined

  constructor() {
    super()
    DeferredAudioContext.instances.push(this)
  }

  override resume() {
    return new Promise<void>((resolve) => {
      this.resumeResolver = () => {
        this.state = 'running'
        resolve()
      }
    })
  }

  resolveResume() {
    this.resumeResolver?.()
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

function createConnection(ws: FakeWebSocket, pc: FakePeerConnection, audioPc = new FakePeerConnection()) {
  const evt = events<any>()
  return {
    sessionId: 'session-1',
    ws,
    pc,
    audioPc,
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

describe('untilFailed audio monitoring cleanup', () => {
  const originalWindow = (globalThis as any).window
  const originalMediaStream = (globalThis as any).MediaStream

  beforeEach(() => {
    jest.useFakeTimers()
    FakeAudioContext.instances = []
    DeferredAudioContext.instances = []
    ;(globalThis as any).window = globalThis
    ;(globalThis as any).MediaStream = FakeMediaStream
    ;(globalThis as any).window.MediaStream = FakeMediaStream
    ;(globalThis as any).window.AudioContext = FakeAudioContext
  })

  afterEach(() => {
    jest.useRealTimers()
    ;(globalThis as any).window = originalWindow
    ;(globalThis as any).MediaStream = originalMediaStream
  })

  test('stops audio activity monitoring after websocket close resolves untilFailed', async () => {
    const ws = new FakeWebSocket()
    const connection = createConnection(ws, new FakePeerConnection())
    const scope = abortable()

    const untilStopped = untilFailed(
      logger,
      connection as any,
      { video: { srcObject: new FakeMediaStream() } } as any,
      createConfig() as any,
      3,
      () => undefined,
      scope,
    )

    await flushPromises()
    expect(ws.send).toHaveBeenCalledTimes(1)

    ws.dispatch('close')
    await untilStopped

    jest.advanceTimersByTime(400)
    await flushPromises()

    expect(ws.send).toHaveBeenCalledTimes(1)
  })

  test('does not emit after abort when AudioContext.resume resolves later', async () => {
    ;(globalThis as any).window.AudioContext = DeferredAudioContext

    const ws = new FakeWebSocket()
    const connection = createConnection(ws, new FakePeerConnection())
    const scope = abortable()

    const untilStopped = untilFailed(
      logger,
      connection as any,
      { video: { srcObject: new FakeMediaStream() } } as any,
      createConfig() as any,
      4,
      () => undefined,
      scope,
    )

    expect(DeferredAudioContext.instances).toHaveLength(1)

    scope.abort()
    await untilStopped

    DeferredAudioContext.instances[0].resolveResume()
    await flushPromises()

    expect(ws.send).not.toHaveBeenCalled()
  })

  test('does not abort the caller scope when websocket close ends untilFailed normally', async () => {
    const ws = new FakeWebSocket()
    const connection = createConnection(ws, new FakePeerConnection())
    const scope = abortable()
    const onAbort = jest.fn()
    scope.onabort(onAbort)

    const untilStopped = untilFailed(
      logger,
      connection as any,
      { video: { srcObject: new FakeMediaStream() } } as any,
      createConfig() as any,
      5,
      () => undefined,
      scope,
    )

    await flushPromises()
    ws.dispatch('close')
    await untilStopped

    expect(onAbort).not.toHaveBeenCalled()
  })
})
