/**
 * DH2D stripe V2: 64x12 repeated blocks, 16x3 cells of 4x4 pixels.
 * Six bytes: version02, raw-active bit0 (other flags zero), two ASCII
 * alphanumeric token bytes, then big-endian CCITT-FALSE CRC of bytes0..3.
 * Invalid copies are ignored; conflicting valid packets invalidate the frame.
 * Undecodable evidence is never interpreted as idle or a playback boundary.
 */

/** Number of horizontal pixels occupied by one stripe repetition. */
export const TURN_STRIPE_WIDTH = 64
/** Number of topmost rows occupied by the stripe. */
export const TURN_STRIPE_HEIGHT = 12
/** Luminance threshold separating black (0) from white (1) cells. */
export const TURN_STRIPE_THRESHOLD = 128

/** A valid turn token: exactly two ASCII alphanumeric characters. */
const TURN_TOKEN_PATTERN = /^[0-9A-Za-z]{2}$/

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
  // Each cell is 4x4 pixels; the stripe grid is 16 cells wide, 3 cells tall.
  let sum = 0
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      sum += luma[(cellY * 4 + y) * width + (cellX * 4 + x)]
    }
  }
  return sum / 16
}

export type TurnStripePacket = { turnId: string, rawAudioActive: boolean }

function decodeRepetition(luma: ArrayLike<number>, width: number, originX: number): TurnStripePacket | null {
  const bytes = new Uint8Array(6)
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 16; col++) {
      const bit = cellAverage(luma, width, originX / 4 + col, row) > TURN_STRIPE_THRESHOLD ? 1 : 0
      bytes[row * 2 + (col >> 3)] = (bytes[row * 2 + (col >> 3)] << 1) | bit
    }
  }
  const token = String.fromCharCode(bytes[2], bytes[3])
  const crc = (bytes[4] << 8) | bytes[5]
  if (bytes[0] !== 2 || (bytes[1] & 0xfe) !== 0
      || !TURN_TOKEN_PATTERN.test(token) || crc !== crc16(bytes.subarray(0, 4))) {
    return null
  }
  return { turnId: token, rawAudioActive: (bytes[1] & 1) !== 0 }
}

export type TurnStripeDecodeResult = {
  /** Valid tokens decoded from the frame, one per repetition, in order. */
  tokens: string[],
  /** Number of invalid repetitions (CRC, version, flags or token). */
  failures: number,
  /** The complete agreeing V2 packet, or null when evidence is undecodable. */
  packet: TurnStripePacket | null,
}

/**
 * Decode every 64-pixel stripe repetition from the topmost 12 rows of a frame.
 * `luma` is the full-frame grayscale/luminance raster of `width` columns.
 */
export function decodeTurnStripe(luma: ArrayLike<number>, width: number): TurnStripeDecodeResult {
  const packets: TurnStripePacket[] = []
  let failures = 0
  if (!Number.isInteger(width) || width < TURN_STRIPE_WIDTH || luma.length < width * TURN_STRIPE_HEIGHT) {
    return { tokens: [], failures, packet: null }
  }
  for (let x = 0; x + TURN_STRIPE_WIDTH <= width; x += TURN_STRIPE_WIDTH) {
    const packet = decodeRepetition(luma, width, x)
    if (packet === null) failures++
    else packets.push(packet)
  }
  const first = packets[0]
  const packet = first && packets.every(p => p.turnId === first.turnId && p.rawAudioActive === first.rawAudioActive) ? first : null
  return { tokens: packet ? packets.map(p => p.turnId) : [], failures, packet }
}

/**
 * Extract the luminance of the topmost 12 rows across the full frame width
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

// Compatibility export while legacy pixel transport is migrated. The playback
// law itself must not depend on decoding stripe pixels or on RTC.
export { createTurnTransitionTracker, type TurnTransition } from '../voice/turnTransition'
