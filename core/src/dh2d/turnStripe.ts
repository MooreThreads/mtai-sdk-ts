/**
 * DH2D avatar video turn-stripe decoding.
 *
 * DH2D stamps the active voice turn token into the topmost 8 pixel rows of
 * every avatar video frame when the session opted into turn metadata. The
 * 64x8 pixel region at the top-left (repeated every 64 pixels horizontally)
 * encodes 32 bits as a 16x2 grid of 4x4 grayscale cells (black=0, white=1):
 *
 *   byte 0: turn token character 0 (ASCII)
 *   byte 1: turn token character 1 (ASCII)
 *   byte 2: CRC16/CCITT-FALSE high byte
 *   byte 3: CRC16/CCITT-FALSE low byte
 *
 * A cell is read by averaging its 4x4 luminance values and thresholding at
 * 128. Frames whose payload is absent, undecodable, or CRC-invalid carry no
 * turn information and must never emit a playback boundary. This mirrors the
 * server-side encoder (`rtc.py turn_stripe_template`) and the e2e harness
 * decoder (`decode_stripe`).
 */

/** Number of horizontal pixels occupied by one stripe repetition. */
export const TURN_STRIPE_WIDTH = 64
/** Number of topmost rows occupied by the stripe. */
export const TURN_STRIPE_HEIGHT = 8
/** Luminance threshold separating black (0) from white (1) cells. */
export const TURN_STRIPE_THRESHOLD = 128

/** CRC-16/CCITT-FALSE: polynomial 0x1021, initial value 0xffff, no reflection. */
export function crc16(payload: Uint8Array): number {
  let crc = 0xffff
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload[i] << 8
    for (let bit = 0; bit < 8; bit++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff
      } else {
        crc = (crc << 1) & 0xffff
      }
    }
  }
  return crc
}

function cellAverage(luma: ArrayLike<number>, width: number, cellX: number, cellY: number): number {
  // Each cell is 4x4 pixels; the stripe grid is 16 cells wide, 2 cells tall.
  let sum = 0
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      sum += luma[(cellY * 4 + y) * width + (cellX * 4 + x)]
    }
  }
  return sum / 16
}

function decodeRepetition(luma: ArrayLike<number>, width: number, originX: number): string | null {
  const bytes = new Uint8Array(4)
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 16; col++) {
      const bit = cellAverage(luma, width, originX / 4 + col, row) > TURN_STRIPE_THRESHOLD ? 1 : 0
      bytes[row * 2 + (col >> 3)] = (bytes[row * 2 + (col >> 3)] << 1) | bit
    }
  }
  const token = String.fromCharCode(bytes[0], bytes[1])
  const crc = (bytes[2] << 8) | bytes[3]
  if (crc !== crc16(bytes.subarray(0, 2))) {
    return null
  }
  return token
}

export type TurnStripeDecodeResult = {
  /** Valid tokens decoded from the frame, one per repetition, in order. */
  tokens: string[],
  /** Number of repetitions that failed CRC validation. */
  failures: number,
}

/**
 * Decode every 64-pixel stripe repetition from the topmost 8 rows of a frame.
 * `luma` is the full-frame grayscale/luminance raster of `width` columns.
 */
export function decodeTurnStripe(luma: ArrayLike<number>, width: number): TurnStripeDecodeResult {
  const tokens: string[] = []
  let failures = 0
  if (typeof width !== 'number' || width < TURN_STRIPE_WIDTH) {
    return { tokens, failures }
  }
  for (let x = 0; x + TURN_STRIPE_WIDTH <= width; x += TURN_STRIPE_WIDTH) {
    const token = decodeRepetition(luma, width, x)
    if (token === null) {
      failures++
    } else {
      tokens.push(token)
    }
  }
  return { tokens, failures }
}

/**
 * Extract the luminance of the topmost 8 rows across the full frame width
 * from RGBA `ImageData`-like video frame pixels, ready for
 * `decodeTurnStripe` (which decodes every 64-pixel repetition).
 */
export function stripeLumaFromImageData(image: { data: ArrayLike<number>, width: number, height: number }): number[] {
  const luma: number[] = []
  for (let y = 0; y < TURN_STRIPE_HEIGHT; y++) {
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4
      const r = image.data[i]
      const g = image.data[i + 1]
      const b = image.data[i + 2]
      luma.push((r + g + b) / 3)
    }
  }
  return luma
}

export type TurnTransition = {
  /**
   * The previous turn when a validated transition confirms its playback
   * boundary, or undefined when the frame confirms nothing.
   */
  endedTurnId: string | undefined,
}

/**
 * Validates avatar turn transitions across decoded frames.
 *
 * A validated transition from turn A to a different valid turn B confirms
 * that A's avatar playback finished; the previous turn is reported, never
 * the newly observed one. The A→idle boundary is reported only through the
 * explicit `endCurrent` signal: DH2D idle frames carry no decodable stripe,
 * and frames with no valid token (idle, corrupt, CRC-failing) or with
 * conflicting tokens are never treated as evidence — neither for a turn
 * transition nor for the idle boundary. Each turn is reported at most once
 * per generation.
 */
export function createTurnTransitionTracker() {
  let currentTurn: string | undefined = undefined
  const reported = new Set<string>()

  function observe(tokens: string[]): TurnTransition {
    const valid = [...new Set(tokens)].filter(token => typeof token === 'string' && token.length === 2)
    if (valid.length !== 1) {
      // No token, or conflicting tokens: the frame is not evidence of a
      // validated transition. Undecodable frames are never read as idle.
      return { endedTurnId: undefined }
    }
    const token = valid[0]
    if (token === currentTurn) {
      return { endedTurnId: undefined }
    }
    const previous = currentTurn
    currentTurn = token
    if (previous === undefined || reported.has(previous)) {
      return { endedTurnId: undefined }
    }
    reported.add(previous)
    return { endedTurnId: previous }
  }

  /**
   * Explicitly signals the end of the current turn's playback (the A→idle
   * boundary). Because idle frames are undecodable, this boundary must come
   * from an explicit lifecycle/media-end signal, never from frame decoding.
   */
  function endCurrent(): TurnTransition {
    const previous = currentTurn
    currentTurn = undefined
    if (previous === undefined || reported.has(previous)) {
      return { endedTurnId: undefined }
    }
    reported.add(previous)
    return { endedTurnId: previous }
  }

  /** The currently tracked turn, or undefined while none is tracked. */
  function currentTurnId(): string | undefined {
    return currentTurn
  }

  function reset() {
    currentTurn = undefined
    reported.clear()
  }

  return { observe, endCurrent, currentTurn: currentTurnId, reset }
}
