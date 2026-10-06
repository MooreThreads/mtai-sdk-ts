import {
  crc16,
  decodeTurnStripe,
  createTurnTransitionTracker,
  stripeLumaFromImageData,
} from './turnStripe'

function payloadOf(token: string): number[] {
  const crc = crc16(Uint8Array.from([token.charCodeAt(0), token.charCodeAt(1)]))
  return [
    token.charCodeAt(0),
    token.charCodeAt(1),
    (crc >> 8) & 0xff,
    crc & 0xff,
  ]
}

function bitsOf(payload: number[]): number[] {
  const bits: number[] = []
  for (const byte of payload) {
    for (let i = 7; i >= 0; i--) {
      bits.push((byte >> i) & 1)
    }
  }
  return bits
}

/** Build one 64x8 stripe region for a token: rows of luminance values. */
function stripeRegion(token: string): number[][] {
  const bits = bitsOf(payloadOf(token))
  const region: number[][] = []
  for (let row = 0; row < 2; row++) {
    for (let py = 0; py < 4; py++) {
      const line: number[] = []
      for (let col = 0; col < 16; col++) {
        const bit = bits[row * 16 + col]
        for (let px = 0; px < 4; px++) {
          line.push(bit ? 235 : 16)
        }
      }
      region.push(line)
    }
  }
  return region
}

/** Full frame luminance grid with the stripe tiled every 64 columns. */
function frameWithStripe(token: string, width: number, height: number, filler = 128): number[] {
  const region = stripeRegion(token)
  const frame: number[] = []
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (y < 8) {
        frame.push(region[y][x % 64])
      } else {
        frame.push(filler)
      }
    }
  }
  return frame
}

describe('crc16', () => {
  test('matches CRC-16/CCITT-FALSE check value', () => {
    expect(crc16(new TextEncoder().encode('123456789'))).toBe(0x29b1)
  })

  test('matches reference values for two-character turn tokens', () => {
    expect(crc16(Uint8Array.from([0x41, 0x30]))).toBe(0x15a1) // 'A0'
    expect(crc16(Uint8Array.from([0x41, 0x31]))).toBe(0x0580) // 'A1'
    expect(crc16(Uint8Array.from([0x7a, 0x7a]))).toBe(0x2540) // 'zz'
  })
})

describe('decodeTurnStripe', () => {
  test('decodes a tiled stripe at frame width 128', () => {
    const { tokens, failures } = decodeTurnStripe(frameWithStripe('A0', 128, 96), 128)
    expect(tokens).toEqual(['A0', 'A0'])
    expect(failures).toBe(0)
  })

  test('decodes the first repetition when width is not a multiple of 64', () => {
    const { tokens } = decodeTurnStripe(frameWithStripe('A0', 96, 96), 96)
    expect(tokens).toEqual(['A0'])
  })

  test('a corrupted repetition is ignored while others still decode', () => {
    const frame = frameWithStripe('A0', 128, 96)
    // Corrupt one full cell in the first repetition.
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        frame[y * 128 + x] = frame[y * 128 + x] > 128 ? 16 : 235
      }
    }
    const { tokens, failures } = decodeTurnStripe(frame, 128)
    expect(tokens).toEqual(['A0'])
    expect(failures).toBe(1)
  })

  test('a frame without a stripe decodes nothing and never throws', () => {
    const frame = new Array(64 * 8).fill(90)
    const { tokens, failures } = decodeTurnStripe(frame, 64)
    expect(tokens).toEqual([])
    expect(failures).toBe(1)
  })

  test('uses the average-luminance threshold 128', () => {
    // Cell averages of exactly 128 read as 0; 129 reads as 1.
    const frame = new Array(64 * 8).fill(128)
    // Build a valid payload with all-zero bits except none: CRC of token
    // '\0\0' is 0x2ec9, so all-zero cells are invalid by CRC; use that to
    // confirm thresholding: all cells at exactly 128 => all bits 0 => CRC
    // mismatch => ignored.
    const { tokens } = decodeTurnStripe(frame, 64)
    expect(tokens).toEqual([])
  })
})

describe('stripeLumaFromImageData', () => {
  test('extracts the top-left 64x8 grayscale region as luminance', () => {
    const region = stripeRegion('B7')
    const data = new Uint8ClampedArray(64 * 8 * 4)
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 64; x++) {
        const value = region[y][x]
        const i = (y * 64 + x) * 4
        data[i] = value
        data[i + 1] = value
        data[i + 2] = value
        data[i + 3] = 255
      }
    }
    const luma = stripeLumaFromImageData({ data, width: 64, height: 8 } as ImageData)
    expect(luma.length).toBe(64 * 8)
    expect(luma).toEqual(region.flat())
  })

  test('extracts every repetition across the full top-row width', () => {
    const region = stripeRegion('B7')
    const width = 192
    const data = new Uint8ClampedArray(width * 8 * 4)
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < width; x++) {
        const value = region[y][x % 64]
        const i = (y * width + x) * 4
        data[i] = value
        data[i + 1] = value
        data[i + 2] = value
        data[i + 3] = 255
      }
    }
    const luma = stripeLumaFromImageData({ data, width, height: 8 } as ImageData)
    expect(luma.length).toBe(width * 8)
    expect(decodeTurnStripe(luma, width).tokens).toEqual(['B7', 'B7', 'B7'])
  })
})

describe('createTurnTransitionTracker', () => {
  test('first observed turn emits nothing', () => {
    const tracker = createTurnTransitionTracker()
    expect(tracker.observe(['A0'])).toEqual({ endedTurnId: undefined })
  })

  test('the same turn emits nothing', () => {
    const tracker = createTurnTransitionTracker()
    tracker.observe(['A0'])
    expect(tracker.observe(['A0'])).toEqual({ endedTurnId: undefined })
  })

  test('a validated A to B transition reports the previous turn', () => {
    const tracker = createTurnTransitionTracker()
    tracker.observe(['A0'])
    expect(tracker.observe(['A1'])).toEqual({ endedTurnId: 'A0' })
  })

  test('an invalid or missing frame emits nothing', () => {
    const tracker = createTurnTransitionTracker()
    tracker.observe(['A0'])
    expect(tracker.observe([])).toEqual({ endedTurnId: undefined })
    expect(tracker.observe(['A0'])).toEqual({ endedTurnId: undefined })
  })

  test('duplicate transitions emit at most once per turn', () => {
    const tracker = createTurnTransitionTracker()
    tracker.observe(['A0'])
    expect(tracker.observe(['A1'])).toEqual({ endedTurnId: 'A0' })
    tracker.observe(['A0'])
    expect(tracker.observe(['A1'])).toEqual({ endedTurnId: undefined })
  })

  test('a frame with conflicting tokens is ignored', () => {
    const tracker = createTurnTransitionTracker()
    tracker.observe(['A0'])
    expect(tracker.observe(['A1', 'B2'])).toEqual({ endedTurnId: undefined })
    expect(tracker.observe(['A1'])).toEqual({ endedTurnId: 'A0' })
  })

  test('transitions chain across turns', () => {
    const tracker = createTurnTransitionTracker()
    tracker.observe(['A0'])
    expect(tracker.observe(['A1']).endedTurnId).toBe('A0')
    expect(tracker.observe(['A2']).endedTurnId).toBe('A1')
    expect(tracker.observe(['A2']).endedTurnId).toBeUndefined()
  })

  test('reset forgets the current turn and emitted history', () => {
    const tracker = createTurnTransitionTracker()
    tracker.observe(['A0'])
    tracker.observe(['A1'])
    tracker.reset()
    expect(tracker.observe(['A1'])).toEqual({ endedTurnId: undefined })
    expect(tracker.observe(['A2']).endedTurnId).toBe('A1')
  })
})

describe('endCurrent', () => {
  test('an explicit media end reports the current turn exactly once', () => {
    const tracker = createTurnTransitionTracker()
    tracker.observe(['A0'])
    expect(tracker.endCurrent()).toEqual({ endedTurnId: 'A0' })
    expect(tracker.endCurrent()).toEqual({ endedTurnId: undefined })
  })

  test('an explicit media end without a current turn emits nothing', () => {
    const tracker = createTurnTransitionTracker()
    expect(tracker.endCurrent()).toEqual({ endedTurnId: undefined })
  })

  test('frames after an explicit media end start a fresh generation', () => {
    const tracker = createTurnTransitionTracker()
    tracker.observe(['A0'])
    tracker.endCurrent()
    expect(tracker.observe(['A0'])).toEqual({ endedTurnId: undefined })
    expect(tracker.observe(['A1'])).toEqual({ endedTurnId: undefined })
    expect(tracker.observe(['B2'])).toEqual({ endedTurnId: 'A1' })
  })

  test('invalid frames never emit and never substitute for an explicit media end', () => {
    const tracker = createTurnTransitionTracker()
    tracker.observe(['A0'])
    expect(tracker.observe([])).toEqual({ endedTurnId: undefined })
    expect(tracker.endCurrent()).toEqual({ endedTurnId: 'A0' })
    expect(tracker.observe([])).toEqual({ endedTurnId: undefined })
  })
})

describe('round trip with the reference encoder layout', () => {
  test('a frame built like rtc.py decodes back to its token', () => {
    // Exactly the fixture payload used by the e2e harness: token 'A0'.
    const { tokens, failures } = decodeTurnStripe(frameWithStripe('A0', 64, 96), 64)
    expect(tokens).toEqual(['A0'])
    expect(failures).toBe(0)
  })
})
