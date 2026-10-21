import {
  createAvatarPlayback,
  createAvatarFrameSampler,
  createAvatarFrameRequester,
} from './avatarMedia'
import { crc16 } from './turnStripe'

function payloadOf(token: string): number[] {
  const crc = crc16(Uint8Array.from([token.charCodeAt(0), token.charCodeAt(1)]))
  return [token.charCodeAt(0), token.charCodeAt(1), (crc >> 8) & 0xff, crc & 0xff]
}

function stripeImageData(token: string | null, width = 64): ImageData {
  const data = new Uint8ClampedArray(width * 8 * 4).fill(128)
  if (token) {
    const bits: number[] = []
    for (const byte of payloadOf(token)) {
      for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1)
    }
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 16; col++) {
        const bit = bits[row * 16 + col]
        for (let y = 0; y < 4; y++) {
          for (let x = 0; x < 4; x++) {
            const value = bit ? 235 : 16
            const i = ((row * 4 + y) * width + col * 4 + x) * 4
            data[i] = value
            data[i + 1] = value
            data[i + 2] = value
            data[i + 3] = 255
          }
        }
      }
    }
  }
  return { data, width, height: 8 } as ImageData
}

/** An ImageData whose top rows tile the stripe across the full width. */
function tiledStripeImageData(token: string | null, width: number): ImageData {
  const data = new Uint8ClampedArray(width * 8 * 4).fill(128)
  if (token) {
    const bits: number[] = []
    for (const byte of payloadOf(token)) {
      for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1)
    }
    const repetitions = Math.floor(width / 64)
    for (let rep = 0; rep < repetitions; rep++) {
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 16; col++) {
          const bit = bits[row * 16 + col]
          for (let y = 0; y < 4; y++) {
            for (let x = 0; x < 4; x++) {
              const value = bit ? 235 : 16
              const i = ((row * 4 + y) * width + rep * 64 + col * 4 + x) * 4
              data[i] = value
              data[i + 1] = value
              data[i + 2] = value
              data[i + 3] = 255
            }
          }
        }
      }
    }
  }
  return { data, width, height: 8 } as ImageData
}

function createManualFrameSource() {
  let callback: (() => void) | undefined
  const requestFrame = (onFrame: () => void) => {
    callback = onFrame
    return () => { callback = undefined }
  }
  return {
    requestFrame,
    emitFrame: () => callback?.(),
  }
}

describe('createAvatarPlayback', () => {
  test('reports the previous turn once on a validated transition', () => {
    const frames = createManualFrameSource()
    const ended: string[] = []
    let image: ImageData | null = stripeImageData('A0')
    const playback = createAvatarPlayback({
      requestFrame: frames.requestFrame,
      sampleFrame: () => image,
      onPlaybackEnded: turnId => ended.push(turnId),
    })
    playback.start()

    frames.emitFrame()
    image = stripeImageData('A0')
    frames.emitFrame()
    expect(ended).toEqual([])

    image = stripeImageData('A1')
    frames.emitFrame()
    expect(ended).toEqual(['A0'])

    image = stripeImageData('A1')
    frames.emitFrame()
    expect(ended).toEqual(['A0'])

    image = stripeImageData('B2')
    frames.emitFrame()
    expect(ended).toEqual(['A0', 'A1'])
  })

  test('invalid frames emit nothing', () => {
    const frames = createManualFrameSource()
    const ended: string[] = []
    let image: ImageData | null = stripeImageData(null)
    const playback = createAvatarPlayback({
      requestFrame: frames.requestFrame,
      sampleFrame: () => image,
      onPlaybackEnded: turnId => ended.push(turnId),
    })
    playback.start()
    frames.emitFrame()
    image = stripeImageData('A0')
    frames.emitFrame()
    image = stripeImageData(null)
    frames.emitFrame()
    image = stripeImageData('A1')
    frames.emitFrame()
    expect(ended).toEqual(['A0'])
  })

  test('a null sample is ignored', () => {
    const frames = createManualFrameSource()
    const ended: string[] = []
    const playback = createAvatarPlayback({
      requestFrame: frames.requestFrame,
      sampleFrame: () => null,
      onPlaybackEnded: turnId => ended.push(turnId),
    })
    playback.start()
    expect(() => frames.emitFrame()).not.toThrow()
    expect(ended).toEqual([])
  })

  test('stop ends the frame loop', () => {
    const frames = createManualFrameSource()
    const ended: string[] = []
    let image: ImageData | null = stripeImageData('A0')
    const playback = createAvatarPlayback({
      requestFrame: frames.requestFrame,
      sampleFrame: () => image,
      onPlaybackEnded: turnId => ended.push(turnId),
    })
    playback.start()
    frames.emitFrame()
    playback.stop()
    image = stripeImageData('A1')
    frames.emitFrame()
    expect(ended).toEqual([])
  })

  test('restart after stop forgets previous transitions', () => {
    const frames = createManualFrameSource()
    const ended: string[] = []
    let image: ImageData | null = stripeImageData('A0')
    const playback = createAvatarPlayback({
      requestFrame: frames.requestFrame,
      sampleFrame: () => image,
      onPlaybackEnded: turnId => ended.push(turnId),
    })
    playback.start()
    frames.emitFrame()
    playback.stop()
    playback.start()
    image = stripeImageData('A1')
    frames.emitFrame()
    expect(ended).toEqual([])
  })

  test('a corrupted repetition still decodes through later repetitions', () => {
    const frames = createManualFrameSource()
    const ended: string[] = []
    let image: ImageData | null = tiledStripeImageData('A0', 192)
    // Corrupt every cell of the first repetition so only the later copies decode.
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 64; x++) {
        const i = (y * 192 + x) * 4
        image.data[i] = image.data[i] > 128 ? 16 : 235
        image.data[i + 1] = image.data[i]
        image.data[i + 2] = image.data[i]
      }
    }
    const playback = createAvatarPlayback({
      requestFrame: frames.requestFrame,
      sampleFrame: () => image,
      onPlaybackEnded: turnId => ended.push(turnId),
    })
    playback.start()
    frames.emitFrame()
    image = tiledStripeImageData('A1', 192)
    frames.emitFrame()
    expect(ended).toEqual(['A0'])
  })
})

describe('createAvatarPlayback notifyMediaEnded', () => {
  test('an explicit media end reports the current turn once', () => {
    const frames = createManualFrameSource()
    const ended: string[] = []
    const image: ImageData | null = stripeImageData('A0')
    const playback = createAvatarPlayback({
      requestFrame: frames.requestFrame,
      sampleFrame: () => image,
      onPlaybackEnded: turnId => ended.push(turnId),
    })
    playback.start()
    frames.emitFrame()
    playback.notifyMediaEnded()
    expect(ended).toEqual(['A0'])
    playback.notifyMediaEnded()
    expect(ended).toEqual(['A0'])
  })

  test('an explicit media end without a current turn emits nothing', () => {
    const frames = createManualFrameSource()
    const ended: string[] = []
    const playback = createAvatarPlayback({
      requestFrame: frames.requestFrame,
      sampleFrame: () => null,
      onPlaybackEnded: turnId => ended.push(turnId),
    })
    playback.start()
    playback.notifyMediaEnded()
    expect(ended).toEqual([])
  })

  test('undecodable frames never emit after an explicit media end', () => {
    const frames = createManualFrameSource()
    const ended: string[] = []
    let image: ImageData | null = stripeImageData('A0')
    const playback = createAvatarPlayback({
      requestFrame: frames.requestFrame,
      sampleFrame: () => image,
      onPlaybackEnded: turnId => ended.push(turnId),
    })
    playback.start()
    frames.emitFrame()
    playback.notifyMediaEnded()
    image = stripeImageData(null)
    frames.emitFrame()
    image = stripeImageData(null)
    frames.emitFrame()
    expect(ended).toEqual(['A0'])
  })

  test('stop forgets the current turn for explicit media ends', () => {
    const frames = createManualFrameSource()
    const ended: string[] = []
    const image: ImageData | null = stripeImageData('A0')
    const playback = createAvatarPlayback({
      requestFrame: frames.requestFrame,
      sampleFrame: () => image,
      onPlaybackEnded: turnId => ended.push(turnId),
    })
    playback.start()
    frames.emitFrame()
    playback.stop()
    playback.notifyMediaEnded()
    expect(ended).toEqual([])
  })

  test('a media end naming a retired turn never retires the tracked turn', () => {
    const frames = createManualFrameSource()
    const ended: string[] = []
    let image: ImageData | null = stripeImageData('A0')
    const playback = createAvatarPlayback({
      requestFrame: frames.requestFrame,
      sampleFrame: () => image,
      onPlaybackEnded: turnId => ended.push(turnId),
    })
    playback.start()
    frames.emitFrame()
    image = stripeImageData('A1')
    frames.emitFrame()
    expect(ended).toEqual(['A0'])
    // A stale lifecycle stop still targeting the retired A0 must never
    // retire the tracked A1.
    playback.notifyMediaEnded('A0')
    expect(ended).toEqual(['A0'])
    playback.notifyMediaEnded('A1')
    expect(ended).toEqual(['A0', 'A1'])
  })

  test('a media end naming an unknown or queued turn never retires the tracked turn', () => {
    const frames = createManualFrameSource()
    const ended: string[] = []
    const image: ImageData | null = stripeImageData('A0')
    const playback = createAvatarPlayback({
      requestFrame: frames.requestFrame,
      sampleFrame: () => image,
      onPlaybackEnded: turnId => ended.push(turnId),
    })
    playback.start()
    frames.emitFrame()
    playback.notifyMediaEnded('B2')
    expect(ended).toEqual([])
    // The tracked turn is still retired exactly once by a matching stop.
    playback.notifyMediaEnded('A0')
    expect(ended).toEqual(['A0'])
  })

  test('a media end without a current tracked turn emits nothing', () => {
    const frames = createManualFrameSource()
    const ended: string[] = []
    const image: ImageData | null = stripeImageData('A0')
    const playback = createAvatarPlayback({
      requestFrame: frames.requestFrame,
      sampleFrame: () => image,
      onPlaybackEnded: turnId => ended.push(turnId),
    })
    playback.start()
    frames.emitFrame()
    playback.notifyMediaEnded('A0')
    playback.notifyMediaEnded('A0')
    expect(ended).toEqual(['A0'])
  })
})

describe('createAvatarPlayback onTurnObserved', () => {
  test('reports every validated turn observation, including repeats', () => {
    const frames = createManualFrameSource()
    const observed: string[] = []
    let image: ImageData | null = stripeImageData('A0')
    const playback = createAvatarPlayback({
      requestFrame: frames.requestFrame,
      sampleFrame: () => image,
      onPlaybackEnded: () => undefined,
      onTurnObserved: turnId => observed.push(turnId),
    })
    playback.start()
    frames.emitFrame()
    frames.emitFrame()
    image = stripeImageData('A1')
    frames.emitFrame()
    image = stripeImageData(null)
    frames.emitFrame()
    expect(observed).toEqual(['A0', 'A0', 'A1'])
  })

  test('missing frames are never reported as observations', () => {
    const frames = createManualFrameSource()
    const observed: string[] = []
    const playback = createAvatarPlayback({
      requestFrame: frames.requestFrame,
      sampleFrame: () => null,
      onPlaybackEnded: () => undefined,
      onTurnObserved: turnId => observed.push(turnId),
    })
    playback.start()
    frames.emitFrame()
    frames.emitFrame()
    expect(observed).toEqual([])
  })

  test('CRC-failing frames are never reported as observations', () => {
    const frames = createManualFrameSource()
    const observed: string[] = []
    // Build a valid 'A1' stripe, then flip the last CRC cell so the
    // repetition fails validation.
    const image: ImageData = stripeImageData('A1')
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const i = ((1 * 4 + y) * 64 + 15 * 4 + x) * 4
        const value = image.data[i] > 128 ? 16 : 235
        image.data[i] = image.data[i + 1] = image.data[i + 2] = value
      }
    }
    let current: ImageData | null = image
    const playback = createAvatarPlayback({
      requestFrame: frames.requestFrame,
      sampleFrame: () => current,
      onPlaybackEnded: () => undefined,
      onTurnObserved: turnId => observed.push(turnId),
    })
    playback.start()
    frames.emitFrame()
    current = stripeImageData('A1')
    frames.emitFrame()
    expect(observed).toEqual(['A1'])
  })
})

describe('createAvatarFrameRequester', () => {
  test('returns null when requestVideoFrameCallback is unavailable', () => {
    expect(createAvatarFrameRequester({} as HTMLVideoElement)).toBeNull()
  })

  test('schedules and cancels video frame callbacks', () => {
    let scheduled = 0
    const cancelled: number[] = []
    const callbacks: ((_: number) => void)[] = []
    const video = {
      requestVideoFrameCallback: (callback: (_: number) => void) => {
        scheduled++
        callbacks.push(callback)
        return scheduled
      },
      cancelVideoFrameCallback: (handle: number) => cancelled.push(handle),
    } as unknown as HTMLVideoElement
    const requestFrame = createAvatarFrameRequester(video)!
    let observed = 0
    const cancel = requestFrame(() => observed++)
    expect(scheduled).toBe(1)
    callbacks[0](1)
    expect(observed).toBe(1)
    cancel()
    expect(cancelled).toEqual([1])
  })
})

describe('createAvatarFrameSampler', () => {
  class FakeContext {
    canvas: any
    drawImageCalls: any[][] = []
    constructor(canvas: any) { this.canvas = canvas }
    drawImage(...args: any[]) { this.drawImageCalls.push(args) }
    getImageData() {
      return this.canvas.nextImage as ImageData
    }
  }

  class FakeCanvas {
    width = 0
    height = 0
    nextImage: ImageData | null = null
    context: FakeContext
    constructor() { this.context = new FakeContext(this) }
    getContext() { return this.context }
  }

  test('samples every stripe repetition across the full frame width', () => {
    const created: FakeCanvas[] = []
    const originalCreate = (globalThis as any).document?.createElement
    ;(globalThis as any).document = {
      ...(globalThis as any).document,
      createElement: () => {
        const canvas = new FakeCanvas()
        created.push(canvas)
        return canvas
      },
    }
    try {
      const video = { videoWidth: 1920, videoHeight: 1080 } as HTMLVideoElement
      const sampler = createAvatarFrameSampler(video)
      expect(created.length).toBe(0)
      sampler()
      canvasLoop: for (const canvas of created) {
        canvas.nextImage = tiledStripeImageData('Z9', 1920)
        const sampled = sampler()
        expect(sampled).not.toBeNull()
        expect(canvas.width).toBe(1920)
        expect(canvas.height).toBe(8)
        expect(canvas.context.drawImageCalls.length).toBeGreaterThan(0)
        for (const call of canvas.context.drawImageCalls) {
          expect(call).toEqual([video, 0, 0, 1920, 8, 0, 0, 1920, 8])
        }
        expect(sampled!.width).toBe(1920)
        expect(sampled!.height).toBe(8)
        break canvasLoop
      }
      expect(created.length).toBe(1)
      // The sampler reuses its canvas across samples.
      sampler()
      expect(created.length).toBe(1)
    } finally {
      if (originalCreate) {
        (globalThis as any).document.createElement = originalCreate
      } else {
        delete (globalThis as any).document
      }
    }
  })

  test('returns null until the video reports its dimensions', () => {
    const originalCreate = (globalThis as any).document?.createElement
    ;(globalThis as any).document = {
      ...(globalThis as any).document,
      createElement: () => new FakeCanvas(),
    }
    try {
      const video = { videoWidth: 0, videoHeight: 0 } as HTMLVideoElement
      const sampler = createAvatarFrameSampler(video)
      expect(sampler()).toBeNull()
    } finally {
      if (originalCreate) {
        (globalThis as any).document.createElement = originalCreate
      } else {
        delete (globalThis as any).document
      }
    }
  })

  test('follows video width changes across samples', () => {
    const created: FakeCanvas[] = []
    const originalCreate = (globalThis as any).document?.createElement
    ;(globalThis as any).document = {
      ...(globalThis as any).document,
      createElement: () => {
        const canvas = new FakeCanvas()
        created.push(canvas)
        return canvas
      },
    }
    try {
      const video: any = { videoWidth: 128, videoHeight: 720 }
      const sampler = createAvatarFrameSampler(video)
      sampler()
      const canvas = created[0]
      canvas.nextImage = tiledStripeImageData('Z9', 128)
      expect(sampler()!.width).toBe(128)
      video.videoWidth = 256
      canvas.nextImage = tiledStripeImageData('Z9', 256)
      const resampled = sampler()
      expect(canvas.width).toBe(256)
      expect(resampled!.width).toBe(256)
      expect(created.length).toBe(1)
    } finally {
      if (originalCreate) {
        (globalThis as any).document.createElement = originalCreate
      } else {
        delete (globalThis as any).document
      }
    }
  })
})

describe('createAvatarPlayback timing records', () => {
  function recordingLogger() {
    const lines: string[] = []
    const logger: any = {
      log: (message: string) => lines.push(String(message)),
      warn: () => undefined,
      error: () => undefined,
    }
    logger.push = () => logger
    return { logger, lines }
  }

  test('records the observed turn only when the decoded token changes', () => {
    const frames = createManualFrameSource()
    const { logger, lines } = recordingLogger()
    let image: ImageData | null = stripeImageData('A0')
    const playback = createAvatarPlayback({
      logger,
      requestFrame: frames.requestFrame,
      sampleFrame: () => image,
      onPlaybackEnded: () => undefined,
    })
    playback.start()

    frames.emitFrame() // first observation of A0
    frames.emitFrame() // repeat of A0: no record
    image = stripeImageData('A1')
    frames.emitFrame() // transition A0 -> A1
    frames.emitFrame() // repeat of A1: no record

    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('turn=A0')
    expect(lines[0]).toContain('previous=-')
    expect(lines[0]).toContain('ended=-')
    expect(lines[1]).toContain('turn=A1')
    expect(lines[1]).toContain('previous=A0')
    expect(lines[1]).toContain('ended=A0')
    expect(lines[1]).toMatch(/now=\d+\.\d{3}/)
    expect(lines[1]).toMatch(/epoch_ms=\d+/)
  })

  test('records no observation line for undecodable frames', () => {
    const frames = createManualFrameSource()
    const { logger, lines } = recordingLogger()
    let image: ImageData | null = stripeImageData('A0')
    const playback = createAvatarPlayback({
      logger,
      requestFrame: frames.requestFrame,
      sampleFrame: () => image,
      onPlaybackEnded: () => undefined,
    })
    playback.start()
    frames.emitFrame()
    image = stripeImageData(null)
    frames.emitFrame()
    frames.emitFrame()
    expect(lines.filter(line => line.includes('turn='))).toHaveLength(1)
  })

  test('records again after a stop and restart with the same token', () => {
    const frames = createManualFrameSource()
    const { logger, lines } = recordingLogger()
    const image = stripeImageData('A0')
    const playback = createAvatarPlayback({
      logger,
      requestFrame: frames.requestFrame,
      sampleFrame: () => image,
      onPlaybackEnded: () => undefined,
    })
    playback.start()
    frames.emitFrame()
    playback.stop()
    playback.start()
    frames.emitFrame()
    expect(lines.filter(line => line.includes('turn=A0'))).toHaveLength(2)
  })

  test('supplies the arriving token with the ended turn and its source', () => {
    const frames = createManualFrameSource()
    const calls: { turn: string, source?: string, next?: string }[] = []
    let image: ImageData | null = stripeImageData('A0')
    const playback = createAvatarPlayback({
      requestFrame: frames.requestFrame,
      sampleFrame: () => image,
      onPlaybackEnded: (turn, source, next) => calls.push({ turn, source, next }),
    })
    playback.start()
    frames.emitFrame()
    image = stripeImageData('A1')
    frames.emitFrame()
    playback.notifyMediaEnded()
    expect(calls).toEqual([
      { turn: 'A0', source: 'stripe', next: 'A1' },
      { turn: 'A1', source: 'lifecycle', next: undefined },
    ])
  })

  test('stamps an observation before the listeners run', () => {
    jest.useFakeTimers()
    try {
      jest.setSystemTime(1_700_000_000_000)
      const frames = createManualFrameSource()
      const { logger, lines } = recordingLogger()
      const image = stripeImageData('A0')
      let listenerEpoch = 0
      const playback = createAvatarPlayback({
        logger,
        requestFrame: frames.requestFrame,
        sampleFrame: () => image,
        onPlaybackEnded: () => undefined,
        onTurnObserved: () => {
          // The listener moves the clock; the record must predate it.
          jest.setSystemTime(Date.now() + 5000)
          listenerEpoch = Date.now()
        },
      })
      playback.start()
      frames.emitFrame()
      expect(lines).toHaveLength(1)
      const recorded = Number(/epoch_ms=(\d+)/.exec(lines[0])![1])
      expect(recorded).toBe(1_700_000_000_000)
      expect(listenerEpoch).toBe(1_700_000_005_000)
    } finally {
      jest.useRealTimers()
    }
  })

  test('a throwing log sink never suppresses playback or observation', () => {
    const frames = createManualFrameSource()
    let image: ImageData | null = stripeImageData('A0')
    const ended: string[] = []
    const observed: string[] = []
    const logger: any = {
      log: () => { throw new Error('sink down') },
      warn: () => undefined,
      error: () => undefined,
      push: () => logger,
    }
    const playback = createAvatarPlayback({
      logger,
      requestFrame: frames.requestFrame,
      sampleFrame: () => image,
      onPlaybackEnded: turn => ended.push(turn),
      onTurnObserved: turn => observed.push(turn),
    })
    playback.start()
    frames.emitFrame()
    image = stripeImageData('A1')
    frames.emitFrame()
    image = stripeImageData('A1')
    frames.emitFrame()
    expect(ended).toEqual(['A0'])
    expect(observed).toEqual(['A0', 'A1', 'A1'])
  })

  test('marks stripe transitions and lifecycle ends as different sources', () => {
    const frames = createManualFrameSource()
    const sources: (string | undefined)[] = []
    let image: ImageData | null = stripeImageData('A0')
    const playback = createAvatarPlayback({
      requestFrame: frames.requestFrame,
      sampleFrame: () => image,
      onPlaybackEnded: (_turn, source) => sources.push(source),
    })
    playback.start()
    frames.emitFrame()
    image = stripeImageData('A1')
    frames.emitFrame()
    playback.notifyMediaEnded()
    expect(sources).toEqual(['stripe', 'lifecycle'])
  })
})
