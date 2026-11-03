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

export type TurnTransition = {
  /**
   * The previous turn when a validated transition confirms its playback
   * boundary, or undefined when the frame confirms nothing.
   */
  endedTurnId: string | undefined,
  /**
   * The validated turn token this frame's observation confirms, or
   * undefined when the frame carried no single valid token (missing,
   * undecodable, CRC-failing, or conflicting). Reported on every validated
   * observation — including repeats of the current turn — so playback
   * consumers can track the avatar's current turn without inferring
   * anything from invalid frames.
   */
  observedTurnId: string | undefined,
}

/**
 * Validates avatar turn transitions across decoded frames.
 *
 * A validated transition from turn A to a different valid turn B confirms
 * that A's avatar playback finished; the previous turn is reported, never
 * the newly observed one. A turn token counts as valid only when it is
 * exactly two ASCII alphanumeric characters: a CRC-valid but
 * non-alphanumeric payload is not a turn and must never be evidence. The
 * A→idle boundary is reported only through the explicit `endCurrent`
 * signal: DH2D idle frames carry no decodable stripe, and frames with no
 * valid token (idle, corrupt, CRC-failing) or with conflicting tokens are
 * never treated as evidence — neither for a turn transition nor for the
 * idle boundary. Each turn is reported at most once per generation, and a
 * retired turn stays rejected for the whole connection/session generation,
 * even after an explicit media end cleared the current turn: only `reset`
 * (a new generation) clears retirement.
 */
export function createTurnTransitionTracker() {
  let currentTurn: string | undefined = undefined
  const reported = new Set<string>()

  function observe(tokens: string[]): TurnTransition {
    const valid = [...new Set(tokens)].filter(token => typeof token === 'string' && TURN_TOKEN_PATTERN.test(token))
    if (valid.length !== 1) {
      // No token, or conflicting tokens: the frame is not evidence of a
      // validated transition or of the current turn. Undecodable frames are
      // never read as idle.
      return { endedTurnId: undefined, observedTurnId: undefined }
    }
    const token = valid[0]
    if (token === currentTurn) {
      return { endedTurnId: undefined, observedTurnId: token }
    }
    if (reported.has(token)) {
      // The token's playback boundary was already confirmed in this
      // generation, so this frame is a stale re-observation of a retired
      // turn: it must never read as a transition away from the current
      // turn, replace it, or re-open after an explicit media end cleared
      // the current turn. Only `reset` — a new connection/session
      // generation — clears retirement.
      return { endedTurnId: undefined, observedTurnId: undefined }
    }
    const previous = currentTurn
    currentTurn = token
    if (previous === undefined || reported.has(previous)) {
      return { endedTurnId: undefined, observedTurnId: token }
    }
    reported.add(previous)
    return { endedTurnId: previous, observedTurnId: token }
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
      return { endedTurnId: undefined, observedTurnId: undefined }
    }
    reported.add(previous)
    return { endedTurnId: previous, observedTurnId: undefined }
  }

  /** Explicit stop of an accepted turn, including one not observed yet.
   * Retire only that ID; a different currently observed turn is untouched.
   */
  function endAcceptedTurn(turnId: string): TurnTransition {
    if (currentTurn === turnId) currentTurn = undefined
    if (reported.has(turnId)) return { endedTurnId: undefined, observedTurnId: undefined }
    reported.add(turnId)
    return { endedTurnId: turnId, observedTurnId: undefined }
  }

  /** The currently tracked turn, or undefined while none is tracked. */
  function currentTurnId(): string | undefined {
    return currentTurn
  }

  function reset() {
    currentTurn = undefined
    reported.clear()
  }

  return { observe, endCurrent, endAcceptedTurn, currentTurn: currentTurnId, reset }
}
