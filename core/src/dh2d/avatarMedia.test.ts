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

  test('samples only the top-left 64x8 region of the current video frame', () => {
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
        canvas.nextImage = stripeImageData('Z9')
        const sampled = sampler()
        expect(sampled).not.toBeNull()
        expect(canvas.context.drawImageCalls.length).toBeGreaterThan(0)
        for (const call of canvas.context.drawImageCalls) {
          expect(call).toEqual([video, 0, 0, 64, 8, 0, 0, 64, 8])
        }
        expect(sampled!.width).toBe(64)
        expect(sampled!.height).toBe(8)
        break canvasLoop
      }
      expect(created.length).toBe(1)
      // The sampler reuses its canvas across samples.
      sampler()
      expect(created.length).toBe(1)
    } finally {
      if (originalCreate) {
        ;(globalThis as any).document.createElement = originalCreate
      } else {
        delete (globalThis as any).document
      }
    }
  })
})
