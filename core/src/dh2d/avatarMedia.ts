import { Logger } from "../types"
import {
  createTurnTransitionTracker,
  decodeTurnStripe,
  stripeLumaFromImageData,
  TURN_STRIPE_HEIGHT,
} from "./turnStripe"

export type AvatarFrameRequester = {
  /**
   * Requests the next video frame observation. Returns a cancellation
   * function. In production this is `video.requestVideoFrameCallback`.
   */
  (onFrame: () => void): () => void,
}

export type AvatarFrameSampler = {
  /** Samples the current frame's top stripe rows across the full width, or null when unavailable. */
  (): ImageData | null,
}

export type AvatarPlaybackOptions = {
  logger?: Logger,
  /** Frame observation source; each call schedules one observation. */
  requestFrame: AvatarFrameRequester,
  /** Samples the current video frame for stripe decoding. */
  sampleFrame: AvatarFrameSampler,
  /** Called with the previous turn when its playback boundary is confirmed. */
  onPlaybackEnded: (_: string, source?: "stripe" | "lifecycle", nextTurnId?: string) => void,
  /**
   * Called with every validated current-turn observation from stripe
   * decoding — including repeats of the current turn. Invalid, missing,
   * CRC-failing, or non-alphanumeric frames are never reported, so they
   * never read as idle or as a transition.
   */
  onTurnObserved?: (_: string) => void,
}

/**
 * Monotonic clock for avatar timing records, in the same domain across the
 * playback observer and the send path. Falls back to wall time when the
 * environment provides no `performance.now`.
 */
export function avatarTimingNow() {
  return typeof performance !== "undefined"
    && typeof performance.now === "function" ? performance.now() : Date.now()
}

/**
 * Watches the avatar video path for DH2D turn-stripe transitions and reports
 * `onPlaybackEnded(previousTurn)` at most once per session/turn when a
 * validated transition confirms the previous turn's playback boundary.
 *
 * DH2D's audio/video synchronization guarantee makes a validated turn
 * transition the playback boundary; no audio-drain algorithm is used. The
 * A→idle boundary — the last turn of a playback sequence returning to idle —
 * cannot be decoded from frames (idle stripes are undecodable and invalid
 * stripes must never emit), so it is reported only through the explicit
 * `notifyMediaEnded` lifecycle/media-end signal.
 */
export function createAvatarPlayback(options: AvatarPlaybackOptions) {
  const logger = options.logger
  const tracker = createTurnTransitionTracker()
  let stopped = true
  let cancelFrame: (() => void) | undefined = undefined
  let lastObservedTurnId: string | undefined = undefined

  function observe() {
    if (stopped) {
      return
    }
    try {
      const image = options.sampleFrame()
      if (image != null) {
        const { tokens } = decodeTurnStripe(stripeLumaFromImageData(image), image.width)
        const { endedTurnId, observedTurnId } = tracker.observe(tokens)
        // The tracker repeats the current turn on every frame, so a timing
        // record is emitted only for an actual token change. The arrival is
        // stamped before the listeners run, but logged after them so the
        // send-side record precedes the observation record.
        const changed = observedTurnId !== undefined && observedTurnId !== lastObservedTurnId
        const previousTurnId = lastObservedTurnId
        const at = changed ? avatarTimingNow() : 0
        const epochMs = changed ? Date.now() : 0
        if (changed) {
          lastObservedTurnId = observedTurnId
        }
        if (endedTurnId !== undefined) {
          options.onPlaybackEnded(endedTurnId, "stripe", observedTurnId)
        }
        if (observedTurnId !== undefined) {
          options.onTurnObserved?.(observedTurnId)
        }
        if (changed) {
          // A diagnostic sink must never break playback or the frame loop.
          try {
            logger?.log(`avatar_turn_observed turn=${observedTurnId}`
              + ` previous=${previousTurnId ?? "-"} ended=${endedTurnId ?? "-"}`
              + ` now=${at.toFixed(3)} epoch_ms=${epochMs}`)
          } catch {
            // Observation logging is diagnostic only.
          }
        }
      }
    } catch (error) {
      // A failing sample (for example a mid-resize frame) must never break
      // the observation loop.
      logger?.error('avatar frame observation failed', error)
    }
    if (!stopped) {
      cancelFrame = options.requestFrame(observe)
    }
  }

  return {
    start() {
      if (!stopped) {
        return
      }
      stopped = false
      tracker.reset()
      lastObservedTurnId = undefined
      cancelFrame = options.requestFrame(observe)
    },
    stop() {
      stopped = true
      tracker.reset()
      lastObservedTurnId = undefined
      cancelFrame?.()
      cancelFrame = undefined
    },
    /**
     * Reports the current turn's playback end on an explicit lifecycle or
     * media-end signal (the A→idle boundary). Idle frames are undecodable,
     * so this boundary is never inferred from stripe decoding; invalid
     * stripes still never emit. When `turnId` names the turn the signal
     * targets, it is validated against the currently tracked turn: a stop
     * targeted at a retired, queued, or otherwise different turn must never
     * retire the tracked one. A signal without a turn id ends the tracked
     * turn (turn-agnostic lifecycle end).
     */
    notifyMediaEnded(turnId?: string) {
      if (turnId !== undefined && tracker.currentTurn() !== turnId) {
        return
      }
      const { endedTurnId } = tracker.endCurrent()
      if (endedTurnId !== undefined) {
        options.onPlaybackEnded(endedTurnId, "lifecycle")
      }
    },
  }
}

/**
 * Creates a production `AvatarFrameSampler` for a `<video>` element playing
 * the DH2D avatar stream. The sampler copies the topmost 8 rows across the
 * full video width so every 64-pixel stripe repetition is decoded — a
 * damaged first copy then still leaves the repeated copies as evidence.
 * No per-frame canvas allocation happens after creation; the canvas is only
 * re-sized when the video dimensions change.
 */
export function createAvatarFrameSampler(video: HTMLVideoElement): AvatarFrameSampler {
  let canvas: HTMLCanvasElement | undefined
  let context: CanvasRenderingContext2D | undefined
  return () => {
    if (typeof document === 'undefined') {
      return null
    }
    const width = video.videoWidth
    if (!width) {
      return null
    }
    if (!canvas) {
      canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = TURN_STRIPE_HEIGHT
      context = canvas.getContext('2d') ?? undefined
    } else if (canvas.width !== width) {
      canvas.width = width
      canvas.height = TURN_STRIPE_HEIGHT
    }
    if (!context) {
      return null
    }
    context.drawImage(video, 0, 0, width, TURN_STRIPE_HEIGHT, 0, 0, width, TURN_STRIPE_HEIGHT)
    return context.getImageData(0, 0, width, TURN_STRIPE_HEIGHT)
  }
}

/**
 * Creates the production `AvatarFrameRequester` for a `<video>` element using
 * `requestVideoFrameCallback`. Returns null when the browser cannot report
 * per-frame callbacks; the caller must then skip playback observation
 * instead of failing the connection (frames without evidence emit nothing).
 */
export function createAvatarFrameRequester(video: HTMLVideoElement): AvatarFrameRequester | null {
  const requestVideoFrameCallback = (video as HTMLVideoElement & {
    requestVideoFrameCallback?: (callback: (_: number) => void) => number,
    cancelVideoFrameCallback?: (handle: number) => void,
  })
  if (typeof requestVideoFrameCallback.requestVideoFrameCallback !== 'function') {
    return null
  }
  return onFrame => {
    const handle: number | undefined = requestVideoFrameCallback.requestVideoFrameCallback.call(video, () => onFrame())
    return () => {
      if (handle !== undefined) {
        requestVideoFrameCallback.cancelVideoFrameCallback?.call(video, handle)
      }
    }
  }
}
