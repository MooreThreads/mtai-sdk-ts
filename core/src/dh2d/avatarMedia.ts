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
  (onFrame: (now?: number, metadata?: Partial<VideoFrameCallbackMetadata>) => void): () => void,
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
  /** Diagnostic hook for changed tokens; invoked in a promise continuation after listeners. */
  onTurnChanged?: (_: string, context: {
    rtpTimestamp: number | null,
    callbackNowMs: number | null,
    performanceOriginMs: number | null,
  }) => void,
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

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function finiteDifference(end: number | null, start: number | null): number | null {
  return end !== null && start !== null ? finiteNumber(end - start) : null
}

function timingNowOrNull(): number | null {
  try {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? finiteNumber(performance.now()) : null
  } catch { return null }
}

function safeMetadataNumber(metadata: Partial<VideoFrameCallbackMetadata> | undefined, field: keyof VideoFrameCallbackMetadata): number | null {
  try { return finiteNumber(metadata?.[field]) } catch { return null }
}

/** Snapshot only allowlisted primitives; never serialize native metadata itself. */
function frameTimingSnapshot(now?: number, metadata?: Partial<VideoFrameCallbackMetadata>): string {
  const callback = finiteNumber(now)
  const receive = finiteNumber(metadata?.receiveTime)
  const presentation = finiteNumber(metadata?.presentationTime)
  const processing = finiteNumber(metadata?.processingDuration)
  return JSON.stringify({
    callback_now_ms: callback,
    receive_time_ms: receive,
    presentation_time_ms: presentation,
    expected_display_time_ms: finiteNumber(metadata?.expectedDisplayTime),
    processing_duration_ms: processing === null ? null : finiteNumber(processing * 1000),
    presented_frames: finiteNumber(metadata?.presentedFrames),
    rtp_timestamp: finiteNumber(metadata?.rtpTimestamp),
    time_origin_ms: finiteNumber(typeof performance !== 'undefined' ? performance.timeOrigin : undefined),
    receive_to_presentation_ms: finiteDifference(presentation, receive),
    presentation_to_callback_ms: finiteDifference(callback, presentation),
  })
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
  let generation = 0

  function observe(now?: number, metadata?: Partial<VideoFrameCallbackMetadata>) {
    if (stopped) {
      return
    }
    const callbackEntryMs = timingNowOrNull()
    try {
      const image = options.sampleFrame()
      const samplingEndMs = timingNowOrNull()
      if (image != null) {
        const { tokens } = decodeTurnStripe(stripeLumaFromImageData(image), image.width)
        const decodingEndMs = timingNowOrNull()
        const { endedTurnId, observedTurnId } = tracker.observe(tokens)
        // The tracker repeats the current turn on every frame, so a timing
        // record is emitted only for an actual token change. The arrival is
        // stamped before the listeners run, but logged after them so the
        // send-side record precedes the observation record.
        const changed = observedTurnId !== undefined && observedTurnId !== lastObservedTurnId
        const previousTurnId = lastObservedTurnId
        const at = changed ? avatarTimingNow() : 0
        const epochMs = changed ? Date.now() : 0
        const context = changed ? {
          rtpTimestamp: safeMetadataNumber(metadata, 'rtpTimestamp'),
          callbackNowMs: finiteNumber(now),
          performanceOriginMs: (() => {
            try { return finiteNumber(typeof performance !== 'undefined' ? performance.timeOrigin : undefined) } catch { return null }
          })(),
        } : undefined
        const observationGeneration = generation
        let frameTiming = ''
        if (changed) {
          lastObservedTurnId = observedTurnId
          try {
            frameTiming = ` frame_timing=${frameTimingSnapshot(now, metadata)}`
          } catch {
            // Native getters or snapshot failures may omit diagnostics, never playback.
          }
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
            const observationTiming = JSON.stringify({
              callback_entry_ms: callbackEntryMs,
              sampling_end_ms: samplingEndMs,
              decoding_end_ms: decodingEndMs,
              callback_to_sampling_ms: finiteDifference(samplingEndMs, callbackEntryMs),
              sampling_to_decoding_ms: finiteDifference(decodingEndMs, samplingEndMs),
              callback_to_decoding_ms: finiteDifference(decodingEndMs, callbackEntryMs),
            })
            logger?.log(`avatar_turn_observed turn=${observedTurnId}`
              + ` previous=${previousTurnId ?? "-"} ended=${endedTurnId ?? "-"}`
              + ` now=${at.toFixed(3)} epoch_ms=${epochMs}${frameTiming} observation_timing=${observationTiming}`)
          } catch {
            // Observation logging is diagnostic only.
          }
          Promise.resolve().then(() => {
            if (!stopped && generation === observationGeneration && context) {
              try { options.onTurnChanged?.(observedTurnId, context) } catch { /* diagnostic hook is isolated */ }
            }
          }).catch(() => undefined)
        }
      }
    } catch (error) {
      // A failing sample (for example a mid-resize frame) must never break
      // the observation loop.
      try { logger?.error('avatar frame observation failed', error) } catch { /* diagnostic logging is isolated */ }
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
      generation++
      tracker.reset()
      lastObservedTurnId = undefined
      cancelFrame = options.requestFrame(observe)
    },
    stop() {
      stopped = true
      generation++
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
    requestVideoFrameCallback?: (callback: VideoFrameRequestCallback) => number,
    cancelVideoFrameCallback?: (handle: number) => void,
  })
  if (typeof requestVideoFrameCallback.requestVideoFrameCallback !== 'function') {
    return null
  }
  return onFrame => {
    const handle: number | undefined = requestVideoFrameCallback.requestVideoFrameCallback.call(video, (now, metadata) => onFrame(now, metadata))
    return () => {
      if (handle !== undefined) {
        requestVideoFrameCallback.cancelVideoFrameCallback?.call(video, handle)
      }
    }
  }
}
