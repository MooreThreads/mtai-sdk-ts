import type { DH2DPlaybackAudioStatus } from 'mtai'

export type PlaybackAnalysis = {
  silenceThresholdReachedAtMs: number | null
  lastListeningAtMs: number | null
  latestListeningDelayMs: number | null
  status: string
}

export function createInitialPlaybackAnalysis(): PlaybackAnalysis {
  return {
    silenceThresholdReachedAtMs: null,
    lastListeningAtMs: null,
    latestListeningDelayMs: null,
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
  }

  if (current.status !== 'listening' && input.status === 'listening') {
    lastListeningAtMs = input.nowMs
    latestListeningDelayMs = silenceThresholdReachedAtMs === null
      ? null
      : Math.max(0, input.nowMs - silenceThresholdReachedAtMs)
  }

  return {
    silenceThresholdReachedAtMs,
    lastListeningAtMs,
    latestListeningDelayMs,
    status: input.status,
  }
}
