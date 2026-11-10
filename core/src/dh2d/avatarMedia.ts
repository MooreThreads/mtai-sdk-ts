import { Logger } from '../types'
import { createTurnTransitionTracker, decodeTurnStripe, stripeLumaFromImageData, TURN_STRIPE_HEIGHT } from './turnStripe'
import { AvatarStripeReadback, StripePixels, StripeReadbackSample, StripeReadbackTiming } from './avatarStripeReadback'

export type AvatarFrameRequester = {
  (onFrame: (now?: number, metadata?: Partial<VideoFrameCallbackMetadata>) => void): () => void,
}
export type AvatarFrameSampler = { (): ImageData | null }
export type AvatarRetirementRequester = { (onReady: () => void): () => void }
/** Submission-time primitives only; native metadata objects are never retained. */
export type AvatarFrameContext = {
  generation: number, sequence: number, callbackEntryMs: number | null,
  frameTiming: string, callbackNowMs: number | null, rtpTimestamp: number | null,
  performanceOriginMs: number | null,
}
export type AvatarPlaybackOptions = {
  logger?: Logger,
  requestFrame: AvatarFrameRequester,
  /** Retained synchronous sampler API and Canvas2D fallback. */
  sampleFrame: AvatarFrameSampler,
  createReadback?: () => AvatarStripeReadback<AvatarFrameContext> | null,
  requestRetirement?: AvatarRetirementRequester,
  onPlaybackEnded: (_: string, source?: 'stripe' | 'lifecycle', nextTurnId?: string) => void,
  /** Every validated observation, including repeats; invalid evidence never means idle. */
  onTurnObserved?: (_: string) => void,
  /** Runs after listeners in a promise continuation, not in the sampling path. */
  onTurnChanged?: (_: string, context: {
    rtpTimestamp: number | null, callbackNowMs: number | null, performanceOriginMs: number | null,
  }) => void,
}
export function avatarTimingNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
}
function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
function finiteDifference(end: number | null, start: number | null): number | null {
  return end !== null && start !== null ? finiteNumber(end - start) : null
}
function timingNowOrNull(): number | null {
  try { return typeof performance !== 'undefined' && typeof performance.now === 'function' ? finiteNumber(performance.now()) : null }
  catch { return null }
}
function originOrNull(): number | null {
  try { return finiteNumber(typeof performance !== 'undefined' ? performance.timeOrigin : undefined) } catch { return null }
}
function safeMetadataNumber(metadata: Partial<VideoFrameCallbackMetadata> | undefined, field: keyof VideoFrameCallbackMetadata): number | null {
  try { return finiteNumber(metadata?.[field]) } catch { return null }
}
/** Preserve the ten native fields, units, signed differences and failure isolation. */
function frameTimingSnapshot(now?: number, metadata?: Partial<VideoFrameCallbackMetadata>): string {
  const callback = finiteNumber(now), receive = finiteNumber(metadata?.receiveTime)
  const presentation = finiteNumber(metadata?.presentationTime), processing = finiteNumber(metadata?.processingDuration)
  return JSON.stringify({
    callback_now_ms: callback, receive_time_ms: receive, presentation_time_ms: presentation,
    expected_display_time_ms: finiteNumber(metadata?.expectedDisplayTime),
    processing_duration_ms: processing === null ? null : finiteNumber(processing * 1000),
    presented_frames: finiteNumber(metadata?.presentedFrames), rtp_timestamp: finiteNumber(metadata?.rtpTimestamp),
    time_origin_ms: originOrNull(), receive_to_presentation_ms: finiteDifference(presentation, receive),
    presentation_to_callback_ms: finiteDifference(callback, presentation),
  })
}
export const requestAvatarRetirement: AvatarRetirementRequester = callback => {
  const id = requestAnimationFrame(callback)
  return () => cancelAnimationFrame(id)
}

/** One tracker/lifecycle owner for synchronous and asynchronous sampled evidence. */
export function createAvatarPlayback(options: AvatarPlaybackOptions) {
  const logger = options.logger, tracker = createTurnTransitionTracker()
  let stopped = true, generation = 0
  let cancelFrame: (() => void) | undefined, cancelRetirement: (() => void) | undefined
  let readback: AvatarStripeReadback<AvatarFrameContext> | undefined
  const requestRetirement = options.requestRetirement ?? (typeof requestAnimationFrame === 'function' ? requestAvatarRetirement : undefined)
  let lastObservedTurnId: string | undefined, observerStartedEpochMs: number | null = null
  const startedTurns = new Set<string>()
  let frameCount = 0, nullSamples = 0, sampledFrames = 0, validFrames = 0, invalidFrames = 0, observationFailures = 0, saturations = 0
  let lastFrameCategory: string | undefined
  function diagnostic(line: () => string) { try { logger?.log(line()) } catch { /* never alter playback */ } }
  function frameState(category: string, detail = '', sequence = frameCount) {
    if (category === lastFrameCategory) return
    lastFrameCategory = category
    return `avatar_frame_state generation=${generation} category=${category} frame_count=${sequence}${detail}`
  }
  function failure() {
    observationFailures++
    try { logger?.error('avatar frame observation failed', 'observation_failed') } catch { /* isolated */ }
    return frameState('observation_failed')
  }
  function active(context: AvatarFrameContext) { return !stopped && context.generation === generation }
  diagnostic(() => 'avatar_observer phase=created')

  function consume(image: StripePixels | null, context: AvatarFrameContext, samplingEndMs: number | null, readbackTiming?: StripeReadbackTiming): string | undefined {
    if (!active(context)) return
    if (!image) { nullSamples++; return frameState('sample_missing', '', context.sequence) }
    sampledFrames++
    const decodeStartMs = readbackTiming ? timingNowOrNull() : undefined
    const { tokens, packet, failures } = decodeTurnStripe(stripeLumaFromImageData(image), image.width)
    const decodingEndMs = timingNowOrNull()
    if (packet) validFrames++; else invalidFrames++
    const stateRecord = frameState(packet ? 'decode_valid' : 'decode_invalid', ` sample=nonnull width=${finiteNumber(image.width)} height=${finiteNumber(image.height)} invalid_repetitions=${failures}`, context.sequence)
    const { endedTurnId, observedTurnId } = tracker.observe(tokens)
    const changed = observedTurnId !== undefined && observedTurnId !== lastObservedTurnId
    const previousTurnId = lastObservedTurnId
    const firstActive = observedTurnId !== undefined && packet?.rawAudioActive === true && !startedTurns.has(observedTurnId)
    if (firstActive) startedTurns.add(observedTurnId)
    const at = changed || firstActive ? avatarTimingNow() : 0
    const epochMs = changed || firstActive ? Date.now() : 0
    const observationStartedEpochMs = observerStartedEpochMs
    if (changed) lastObservedTurnId = observedTurnId
    if (endedTurnId !== undefined) options.onPlaybackEnded(endedTurnId, 'stripe', observedTurnId)
    if (!active(context)) return
    if (observedTurnId !== undefined) options.onTurnObserved?.(observedTurnId)
    // Record evidence already established before a listener stopped/restarted;
    // only future delivery and the deferred diagnostic hook are fenced.
    if (firstActive) diagnostic(() => `avatar_response_started turn=${observedTurnId} stripe_version=2 raw_active=1`
      + ` generation=${context.generation} epoch_ms=${epochMs} observer_started_epoch_ms=${observationStartedEpochMs}${context.frameTiming}`)
    if (changed) {
      diagnostic(() => {
        const observationTiming = JSON.stringify({
          callback_entry_ms: context.callbackEntryMs, sampling_end_ms: samplingEndMs, decoding_end_ms: decodingEndMs,
          callback_to_sampling_ms: finiteDifference(samplingEndMs, context.callbackEntryMs),
          sampling_to_decoding_ms: finiteDifference(decodingEndMs, samplingEndMs),
          callback_to_decoding_ms: finiteDifference(decodingEndMs, context.callbackEntryMs),
        })
        return `avatar_turn_observed turn=${observedTurnId} previous=${previousTurnId ?? '-'} ended=${endedTurnId ?? '-'}`
          + ` now=${at.toFixed(3)} epoch_ms=${epochMs}${context.frameTiming} observation_timing=${observationTiming}`
          + (readbackTiming ? ` readback_timing=${JSON.stringify({ backend: 'webgl2', sequence: context.sequence, generation: context.generation, ...readbackTiming, decode_start_ms: decodeStartMs, decode_end_ms: decodingEndMs })}` : '')
      })
      Promise.resolve().then(() => {
        if (active(context)) {
          try { options.onTurnChanged?.(observedTurnId, {
            rtpTimestamp: context.rtpTimestamp, callbackNowMs: context.callbackNowMs, performanceOriginMs: context.performanceOriginMs,
          }) } catch { /* diagnostic hook isolated */ }
        }
      }).catch(() => undefined)
    }
    return stateRecord
  }
  function deliver(sample: StripeReadbackSample<AvatarFrameContext>) {
    if (!active(sample.context)) return
    try {
      const line = consume(sample.image, sample.context, sample.timing.copy_end_ms, sample.timing)
      if (line) diagnostic(() => line)
    } catch { const line = failure(); if (line) diagnostic(() => line) }
  }
  function fallback() {
    const previous = readback
    readback = undefined
    cancelRetirement?.(); cancelRetirement = undefined
    previous?.dispose()
    diagnostic(() => 'avatar_readback backend=canvas2d reason=readback_unavailable')
    // Do not reset the tracker: this is a backend change, not a new voice session.
  }
  function retire() {
    cancelRetirement = undefined
    const owner = readback
    if (!owner || stopped) return
    try {
      for (const sample of owner.retireReady()) {
        if (readback !== owner || stopped) break
        deliver(sample)
      }
      if (readback === owner && !stopped && owner.pending) scheduleRetirement()
    } catch { if (readback === owner) fallback() }
  }
  function scheduleRetirement() {
    if (!stopped && readback?.pending && !cancelRetirement && requestRetirement) {
      const owner = readback, scheduledGeneration = generation
      cancelRetirement = requestRetirement(() => {
        if (!stopped && generation === scheduledGeneration && readback === owner) retire()
      })
    }
  }
  function scheduleFrame() {
    const scheduledGeneration = generation
    cancelFrame = options.requestFrame((now, metadata) => {
      if (!stopped && generation === scheduledGeneration) observe(now, metadata)
    })
  }
  function observe(now?: number, metadata?: Partial<VideoFrameCallbackMetadata>) {
    if (stopped) return
    const callbackEntryMs = timingNowOrNull()
    frameCount++
    let frameTiming = ''
    try { frameTiming = ` frame_timing=${frameTimingSnapshot(now, metadata)}` } catch { /* snapshot failure never affects observations */ }
    const context: AvatarFrameContext = {
      generation, sequence: frameCount, callbackEntryMs, frameTiming,
      callbackNowMs: finiteNumber(now), rtpTimestamp: safeMetadataNumber(metadata, 'rtpTimestamp'), performanceOriginMs: originOrNull(),
    }
    const first = frameCount === 1 ? `avatar_observer phase=first_callback generation=${generation} frame_count=1`
      + ` width=${safeMetadataNumber(metadata, 'width')} height=${safeMetadataNumber(metadata, 'height')}`
      + ` media_time=${safeMetadataNumber(metadata, 'mediaTime')}${frameTiming}` : ''
    let stateRecord: string | undefined
    try {
      const owner = readback
      if (owner) {
        try {
          // Capture now, before saturation can block or emit reentrant listeners.
          if (owner.prepare()) {
            for (const sample of owner.retireReady()) {
              if (!active(context) || readback !== owner) break
              deliver(sample)
            }
            if (active(context) && readback === owner && owner.pending === 2) {
              const start = timingNowOrNull(), sample = owner.retireOldestBlocking()
              if (sample) deliver(sample)
              saturations++
              diagnostic(() => `avatar_readback_saturation count=${saturations} duration_ms=${finiteDifference(timingNowOrNull(), start)}`)
            }
            if (active(context) && readback === owner) { owner.submit(context); scheduleRetirement() }
          } else stateRecord = consume(null, context, timingNowOrNull())
        } catch {
          if (active(context) && readback === owner) fallback()
          if (active(context) && !readback) stateRecord = consume(options.sampleFrame(), context, timingNowOrNull())
        }
      } else stateRecord = consume(options.sampleFrame(), context, timingNowOrNull())
    } catch { if (active(context)) stateRecord = failure() }
    if (active(context)) scheduleFrame()
    if (first) diagnostic(() => first)
    if (stateRecord) diagnostic(() => stateRecord!)
  }
  return {
    start() {
      if (!stopped) return
      stopped = false; generation++
      try { const now = timingNowOrNull(), origin = originOrNull(); observerStartedEpochMs = now !== null && origin !== null ? finiteNumber(origin + now) : null }
      catch { observerStartedEpochMs = null }
      tracker.reset(); startedTurns.clear(); lastObservedTurnId = undefined
      frameCount = nullSamples = sampledFrames = validFrames = invalidFrames = observationFailures = saturations = 0
      lastFrameCategory = undefined
      if (options.createReadback && requestRetirement) {
        try { readback = options.createReadback() ?? undefined } catch { readback = undefined }
        diagnostic(() => `avatar_readback backend=${readback ? 'webgl2' : 'canvas2d'}`)
      }
      scheduleFrame()
      diagnostic(() => `avatar_observer phase=started generation=${generation}`)
    },
    stop() {
      const wasRunning = !stopped, stoppedGeneration = generation
      stopped = true; generation++
      cancelFrame?.(); cancelFrame = undefined
      cancelRetirement?.(); cancelRetirement = undefined
      const owner = readback; readback = undefined; owner?.dispose()
      tracker.reset(); startedTurns.clear(); lastObservedTurnId = undefined
      if (wasRunning) diagnostic(() => `avatar_observer phase=stopped generation=${stoppedGeneration} frame_count=${frameCount}`
        + ` null_samples=${nullSamples} sampled_frames=${sampledFrames} valid_frames=${validFrames}`
        + ` invalid_frames=${invalidFrames} observation_failures=${observationFailures}`)
    },
    /** Ordinary ends retire only their intended/current turn; pending new turns remain observable. */
    notifyMediaEnded(turnId?: string, acceptedOutput = false) {
      if (turnId !== undefined && tracker.currentTurn() !== turnId && !acceptedOutput) return
      const { endedTurnId } = acceptedOutput && turnId !== undefined ? tracker.endAcceptedTurn(turnId) : tracker.endCurrent()
      if (endedTurnId !== undefined) options.onPlaybackEnded(endedTurnId, 'lifecycle')
    },
  }
}

/** Reused synchronous sampler; also the startup/context-loss fallback. */
export function createAvatarFrameSampler(video: HTMLVideoElement): AvatarFrameSampler {
  let canvas: HTMLCanvasElement | undefined
  let context: CanvasRenderingContext2D | undefined
  return () => {
    if (typeof document === 'undefined') return null
    const width = video.videoWidth
    if (!width) return null
    if (!canvas) {
      canvas = document.createElement('canvas'); canvas.width = width; canvas.height = TURN_STRIPE_HEIGHT
      context = canvas.getContext('2d', { willReadFrequently: false }) ?? undefined
    } else if (canvas.width !== width) { canvas.width = width; canvas.height = TURN_STRIPE_HEIGHT }
    if (!context) return null
    context.drawImage(video, 0, 0, width, TURN_STRIPE_HEIGHT, 0, 0, width, TURN_STRIPE_HEIGHT)
    return context.getImageData(0, 0, width, TURN_STRIPE_HEIGHT)
  }
}
export function createAvatarFrameRequester(video: HTMLVideoElement): AvatarFrameRequester | null {
  const requester = video as HTMLVideoElement & {
    requestVideoFrameCallback?: (callback: VideoFrameRequestCallback) => number,
    cancelVideoFrameCallback?: (handle: number) => void,
  }
  if (typeof requester.requestVideoFrameCallback !== 'function') return null
  return onFrame => {
    const handle = requester.requestVideoFrameCallback!.call(video, (now, metadata) => onFrame(now, metadata))
    return () => { if (handle !== undefined) requester.cancelVideoFrameCallback?.call(video, handle) }
  }
}
