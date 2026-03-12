import {
  calculateRms,
  createAudioActivityMessageBuilder,
  createAudioActivityTracker,
  nextConnectionSeq,
} from './audioActivity'

describe('createAudioActivityTracker', () => {
  test('reports audio active when rms is above threshold', () => {
    const tracker = createAudioActivityTracker({
      threshold: 0.1,
      silenceTailMs: 400,
      sampleIntervalMs: 100,
    })

    expect(tracker.update(0.12)).toEqual({
      audioActive: true,
      rms: 0.12,
      silentForMs: 0,
    })
  })

  test('accumulates silence until the configured tail is reached', () => {
    const tracker = createAudioActivityTracker({
      threshold: 0.1,
      silenceTailMs: 400,
      sampleIntervalMs: 100,
    })

    tracker.update(0.2)

    expect(tracker.update(0.01)).toEqual({
      audioActive: false,
      rms: 0.01,
      silentForMs: 100,
    })
    expect(tracker.update(0.01)).toEqual({
      audioActive: false,
      rms: 0.01,
      silentForMs: 200,
    })
    expect(tracker.update(0.01)).toEqual({
      audioActive: false,
      rms: 0.01,
      silentForMs: 300,
    })
    expect(tracker.update(0.01)).toEqual({
      audioActive: false,
      rms: 0.01,
      silentForMs: 400,
    })
  })

  test('resets silent duration after speech resumes', () => {
    const tracker = createAudioActivityTracker({
      threshold: 0.1,
      silenceTailMs: 400,
      sampleIntervalMs: 100,
    })

    tracker.update(0.2)
    tracker.update(0.01)
    tracker.update(0.01)

    expect(tracker.update(0.2)).toEqual({
      audioActive: true,
      rms: 0.2,
      silentForMs: 0,
    })
  })
})

describe('audio activity telemetry helpers', () => {
  test('calculates rms from PCM samples', () => {
    expect(calculateRms(new Float32Array([0, 1, -1, 0]))).toBeCloseTo(
      Math.sqrt(0.5),
    )
  })

  test('increments connection sequence numbers', () => {
    expect(nextConnectionSeq(0)).toBe(1)
    expect(nextConnectionSeq(1)).toBe(2)
  })

  test('serializes activity messages with monotonic activity sequence numbers', () => {
    const tracker = createAudioActivityTracker({
      threshold: 0.1,
      silenceTailMs: 400,
      sampleIntervalMs: 100,
    })
    const buildMessage = createAudioActivityMessageBuilder(3)

    expect(buildMessage(tracker.update(0.2))).toEqual({
      type: 'dh_2d_audio_activity',
      connection_seq: 3,
      activity_seq: 1,
      audio_active: true,
      rms: 0.2,
      silent_for_ms: 0,
    })
    expect(buildMessage(tracker.update(0.01))).toEqual({
      type: 'dh_2d_audio_activity',
      connection_seq: 3,
      activity_seq: 2,
      audio_active: false,
      rms: 0.01,
      silent_for_ms: 100,
    })
  })
})
