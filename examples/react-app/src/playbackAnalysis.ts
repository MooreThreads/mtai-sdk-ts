import type { DH2DPlaybackAudioStatus } from 'mtai'

export type PlaybackAnalysis = {
  silenceThresholdReachedAtMs: number | null
  lastListeningAtMs: number | null
  latestListeningDelayMs: number | null
  latestListeningError: string | null
  status: string
}

export function createInitialPlaybackAnalysis(): PlaybackAnalysis {
  return {
    silenceThresholdReachedAtMs: null,
    lastListeningAtMs: null,
    latestListeningDelayMs: null,
    latestListeningError: null,
    status: 'sleeping',
  }
}

export function advancePlaybackAnalysis(
  current: PlaybackAnalysis,
  input: {
    status: string
    audioStatus: DH2DPlaybackAudioStatus
    nowMs: number
  },
): PlaybackAnalysis {
  let silenceThresholdReachedAtMs = current.silenceThresholdReachedAtMs
  let lastListeningAtMs = current.lastListeningAtMs
  let latestListeningDelayMs = current.latestListeningDelayMs
  let latestListeningError = current.latestListeningError
  const justReachedSilenceThreshold = !input.audioStatus.audioActive
    && input.audioStatus.silentForMs >= 400
    && silenceThresholdReachedAtMs === null

  if (input.audioStatus.audioActive) {
    silenceThresholdReachedAtMs = null
  } else if (
    input.audioStatus.silentForMs >= 400
    && silenceThresholdReachedAtMs === null
  ) {
    silenceThresholdReachedAtMs = input.nowMs - (input.audioStatus.silentForMs - 400)
  }

  if (input.status === 'talking') {
    lastListeningAtMs = null
    latestListeningError = null
  }

  if (current.status !== 'listening' && input.status === 'listening') {
    lastListeningAtMs = input.nowMs
    if (silenceThresholdReachedAtMs === null) {
      latestListeningDelayMs = null
      latestListeningError = 'listening started before silence-400'
    } else {
      latestListeningDelayMs = Math.max(0, input.nowMs - silenceThresholdReachedAtMs)
      latestListeningError = null
    }
  } else if (
    input.status === 'listening'
    && justReachedSilenceThreshold
    && latestListeningDelayMs === null
  ) {
    latestListeningError = 'listening started before silence-400'
  }

  return {
    silenceThresholdReachedAtMs,
    lastListeningAtMs,
    latestListeningDelayMs,
    latestListeningError,
    status: input.status,
  }
}
