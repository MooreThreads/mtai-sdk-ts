export type AudioActivityTrackerOptions = {
  threshold: number
  silenceTailMs: number
  sampleIntervalMs: number
}

export type AudioActivityState = {
  audioActive: boolean
  rms: number
  silentForMs: number
}

export type AudioActivityMessage = {
  type: 'dh_2d_audio_activity'
  connection_seq: number
  activity_seq: number
  audio_active: boolean
  rms: number
  silent_for_ms: number
}

export function calculateRms(samples: Float32Array): number {
  let sum = 0
  for (const sample of samples) {
    sum += sample * sample
  }
  return Math.sqrt(sum / samples.length)
}

export function nextConnectionSeq(current: number): number {
  return current + 1
}

export function createAudioActivityTracker(options: AudioActivityTrackerOptions) {
  let silentForMs = 0

  return {
    update(rms: number): AudioActivityState {
      const audioActive = rms >= options.threshold
      if (audioActive) {
        silentForMs = 0
      } else {
        silentForMs = Math.min(
          silentForMs + options.sampleIntervalMs,
          options.silenceTailMs,
        )
      }

      return {
        audioActive,
        rms,
        silentForMs,
      }
    },
  }
}

export function createAudioActivityMessageBuilder(connectionSeq: number) {
  let activitySeq = 0

  return (state: AudioActivityState): AudioActivityMessage => ({
    type: 'dh_2d_audio_activity',
    connection_seq: connectionSeq,
    activity_seq: ++activitySeq,
    audio_active: state.audioActive,
    rms: state.rms,
    silent_for_ms: state.silentForMs,
  })
}
