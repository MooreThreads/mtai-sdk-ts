import {
  createVoiceMicrophone,
  encodePcm16Mono,
  VOICE_INPUT_SAMPLE_RATE,
} from './microphone'

class FakeMediaStream {
  static instances: FakeMediaStream[] = []
  readonly audioTracks: { stop: jest.Mock }[]
  constructor() {
    this.audioTracks = [{ stop: jest.fn() }]
    FakeMediaStream.instances.push(this)
  }
  getAudioTracks() {
    return this.audioTracks
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  readonly sampleRate: number
  state: 'running' | 'closed' = 'running'
  closed = false
  source: { connect: jest.Mock; disconnect: jest.Mock } | undefined
  processor: {
    bufferSize: number
    onaudioprocess: ((event: any) => void) | undefined
    connect: jest.Mock
    disconnect: jest.Mock
  } | undefined
  gain: { gain: { value: number }; connect: jest.Mock; disconnect: jest.Mock } | undefined
  readonly destination = {}
  constructor(sampleRate = VOICE_INPUT_SAMPLE_RATE) {
    this.sampleRate = sampleRate
    FakeAudioContext.instances.push(this)
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
  async resume() {
    this.state = 'running'
  }
  async close() {
    this.closed = true
    this.state = 'closed'
  }
}

function stubGlobals(options: { sampleRate?: number, getUserMedia?: jest.Mock } = {}) {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const originalAudioContext = (globalThis as any).AudioContext
  const getUserMedia = options.getUserMedia ?? jest.fn(async () => new FakeMediaStream())
  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: { getUserMedia } },
    writable: true,
    configurable: true,
  })
  const sampleRate = options.sampleRate ?? VOICE_INPUT_SAMPLE_RATE
  Object.defineProperty(globalThis, 'AudioContext', {
    value: class extends FakeAudioContext {
      constructor() {
        super(sampleRate)
      }
    },
    writable: true,
    configurable: true,
  })
  return {
    getUserMedia,
    restore: () => {
      if (originalNavigator) {
        Object.defineProperty(globalThis, 'navigator', originalNavigator)
      }
      (globalThis as any).AudioContext = originalAudioContext
    },
  }
}

function triggerAudio(samples: Float32Array) {
  const context = FakeAudioContext.instances[FakeAudioContext.instances.length - 1]
  context.processor!.onaudioprocess!({
    inputBuffer: { getChannelData: () => samples },
  })
}

describe('encodePcm16Mono', () => {
  test('passes samples through at the target rate as little-endian PCM16', () => {
    const bytes = encodePcm16Mono(new Float32Array([0, 0.5, -0.5, 1]), VOICE_INPUT_SAMPLE_RATE)
    expect(Array.from(bytes)).toEqual([0, 0, 0, 0x40, 0x01, 0xc0, 0xff, 0x7f])
  })

  test('clamps out-of-range samples', () => {
    const bytes = encodePcm16Mono(new Float32Array([2, -2]), VOICE_INPUT_SAMPLE_RATE)
    expect(Array.from(bytes)).toEqual([0xff, 0x7f, 0x01, 0x80])
  })

  test('linearly resamples to the target rate', () => {
    const bytes = encodePcm16Mono(new Float32Array([0, 9, 9, 0.5, 9, 9]), 48000)
    expect(bytes.byteLength).toBe(4)
    expect(Array.from(bytes)).toEqual([0, 0, 0, 0x40])
  })

  test('handles empty batches', () => {
    expect(encodePcm16Mono(new Float32Array(0), VOICE_INPUT_SAMPLE_RATE).byteLength).toBe(0)
  })
})

describe('createVoiceMicrophone', () => {
  beforeEach(() => {
    FakeMediaStream.instances = []
    FakeAudioContext.instances = []
  })

  test('captures the default device through getUserMedia', async () => {
    const globals = stubGlobals()
    try {
      const microphone = createVoiceMicrophone({ audioInput: true, onPcm: () => undefined })
      await microphone.ready
      expect(globals.getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: true }, video: false })
      expect(FakeAudioContext.instances.length).toBe(1)
    } finally {
      globals.restore()
    }
  })

  test('uses a provided MediaStream without getUserMedia and without stopping its tracks', async () => {
    const globals = stubGlobals()
    try {
      const stream = new FakeMediaStream()
      const microphone = createVoiceMicrophone({ audioInput: stream as unknown as MediaStream, onPcm: () => undefined })
      await microphone.ready
      expect(globals.getUserMedia).not.toHaveBeenCalled()
      microphone.stop()
      expect(stream.audioTracks[0].stop).not.toHaveBeenCalled()
      expect(FakeAudioContext.instances[0].closed).toBe(true)
    } finally {
      globals.restore()
    }
  })

  test('wires the capture graph through a zero-gain sink', async () => {
    const globals = stubGlobals()
    try {
      const microphone = createVoiceMicrophone({ audioInput: true, onPcm: () => undefined })
      await microphone.ready
      const context = FakeAudioContext.instances[0]
      expect(context.processor!.bufferSize).toBeGreaterThan(0)
      expect(context.source!.connect).toHaveBeenCalledWith(context.processor)
      expect(context.processor!.connect).toHaveBeenCalledWith(context.gain)
      expect(context.gain!.gain.value).toBe(0)
      expect(context.gain!.connect).toHaveBeenCalledWith(context.destination)
    } finally {
      globals.restore()
    }
  })

  test('delivers PCM batches from audio processing callbacks', async () => {
    const globals = stubGlobals()
    try {
      const batches: Uint8Array[] = []
      const microphone = createVoiceMicrophone({ audioInput: true, onPcm: pcm => batches.push(pcm) })
      await microphone.ready
      triggerAudio(new Float32Array([0, 0.5, -0.5, 1]))
      expect(batches.length).toBe(1)
      expect(Array.from(batches[0])).toEqual([0, 0, 0, 0x40, 0x01, 0xc0, 0xff, 0x7f])
    } finally {
      globals.restore()
    }
  })

  test('stop closes the context, releases the acquired stream, and gates further batches', async () => {
    const globals = stubGlobals()
    try {
      const batches: Uint8Array[] = []
      const microphone = createVoiceMicrophone({ audioInput: true, onPcm: pcm => batches.push(pcm) })
      await microphone.ready
      const stream = FakeMediaStream.instances[0]
      microphone.stop()
      triggerAudio(new Float32Array([0.5]))
      expect(batches.length).toBe(0)
      expect(stream.audioTracks[0].stop).toHaveBeenCalled()
      expect(FakeAudioContext.instances[0].closed).toBe(true)
      microphone.stop()
    } finally {
      globals.restore()
    }
  })

  test('stop during acquisition releases the stream once getUserMedia resolves', async () => {
    let resolveGetUserMedia: ((stream: MediaStream) => void) | undefined
    const getUserMedia = jest.fn(() => new Promise<MediaStream>(resolve => {
      resolveGetUserMedia = resolve
    }))
    const globals = stubGlobals({ getUserMedia })
    try {
      const microphone = createVoiceMicrophone({ audioInput: true, onPcm: () => undefined })
      microphone.stop()
      const stream = new FakeMediaStream()
      resolveGetUserMedia!(stream as unknown as MediaStream)
      await microphone.ready
      expect(stream.audioTracks[0].stop).toHaveBeenCalled()
      expect(FakeAudioContext.instances.length).toBe(0)
    } finally {
      globals.restore()
    }
  })

  test('ready rejects when the AudioContext is unavailable', async () => {
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    const originalAudioContext = (globalThis as any).AudioContext
    Object.defineProperty(globalThis, 'navigator', {
      value: { mediaDevices: { getUserMedia: async () => new FakeMediaStream() } },
      writable: true,
      configurable: true,
    })
    delete (globalThis as any).AudioContext
    delete (globalThis as any).webkitAudioContext
    try {
      const microphone = createVoiceMicrophone({ audioInput: true, onPcm: () => undefined })
      await expect(microphone.ready).rejects.toThrow('AudioContext')
    } finally {
      (globalThis as any).AudioContext = originalAudioContext
      if (originalNavigator) {
        Object.defineProperty(globalThis, 'navigator', originalNavigator)
      }
    }
  })

  test('ready rejects when getUserMedia fails', async () => {
    const getUserMedia = jest.fn(async () => {
      throw new Error('no microphone')
    })
    const globals = stubGlobals({ getUserMedia })
    try {
      const microphone = createVoiceMicrophone({ audioInput: true, onPcm: () => undefined })
      await expect(microphone.ready).rejects.toThrow('no microphone')
    } finally {
      globals.restore()
    }
  })
})

test('prepared track loss notifies and cleans up; explicit stop removes the listener', async () => {
  const stream = new FakeMediaStream()
  let ended!: () => void
  const track = stream.audioTracks[0] as any
  track.addEventListener = jest.fn((name: string, callback: () => void) => { ended = callback })
  track.removeEventListener = jest.fn()
  const globals = stubGlobals({ getUserMedia: jest.fn(async () => stream) })
  const onLost = jest.fn()
  try {
    const mic = createVoiceMicrophone({ audioInput: true, onPcm() {}, onLost })
    await mic.ready
    ended()
    expect(onLost).toHaveBeenCalledTimes(1)
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(track.removeEventListener).toHaveBeenCalledWith('ended', ended)
    ended()
    expect(onLost).toHaveBeenCalledTimes(1)
  } finally { globals.restore() }
})
