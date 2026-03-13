import {
  calculateRms,
  createAudioActivityMessageBuilder,
  createAudioActivityReporter,
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

  test('accumulates silence beyond the configured tail threshold', () => {
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
    expect(tracker.update(0.01)).toEqual({
      audioActive: false,
      rms: 0.01,
      silentForMs: 500,
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

  test('keeps reporting each silence step until the silence tail is reached', () => {
    const reporter = createAudioActivityReporter({
      silenceTailMs: 400,
      sampleIntervalMs: 100,
      activeHeartbeatMs: 500,
      silenceHeartbeatMs: 500,
      rmsDeltaThreshold: 0.02,
    })

    expect(reporter.shouldReport({
      audioActive: true,
      rms: 0.3,
      silentForMs: 0,
    })).toBe(true)

    expect(reporter.shouldReport({
      audioActive: false,
      rms: 0.01,
      silentForMs: 100,
    })).toBe(true)
    expect(reporter.shouldReport({
      audioActive: false,
      rms: 0.01,
      silentForMs: 200,
    })).toBe(true)
    expect(reporter.shouldReport({
      audioActive: false,
      rms: 0.01,
      silentForMs: 300,
    })).toBe(true)
    expect(reporter.shouldReport({
      audioActive: false,
      rms: 0.01,
      silentForMs: 400,
    })).toBe(true)
  })

  test('throttles steady silence once the backend threshold has already been reached', () => {
    const reporter = createAudioActivityReporter({
      silenceTailMs: 400,
      sampleIntervalMs: 100,
      activeHeartbeatMs: 500,
      silenceHeartbeatMs: 500,
      rmsDeltaThreshold: 0.02,
    })

    reporter.shouldReport({
      audioActive: false,
      rms: 0.01,
      silentForMs: 100,
    })
    reporter.shouldReport({
      audioActive: false,
      rms: 0.01,
      silentForMs: 200,
    })
    reporter.shouldReport({
      audioActive: false,
      rms: 0.01,
      silentForMs: 300,
    })
    reporter.shouldReport({
      audioActive: false,
      rms: 0.01,
      silentForMs: 400,
    })

    expect(reporter.shouldReport({
      audioActive: false,
      rms: 0.01,
      silentForMs: 500,
    })).toBe(false)
    expect(reporter.shouldReport({
      audioActive: false,
      rms: 0.01,
      silentForMs: 600,
    })).toBe(false)
    expect(reporter.shouldReport({
      audioActive: false,
      rms: 0.01,
      silentForMs: 700,
    })).toBe(false)
    expect(reporter.shouldReport({
      audioActive: false,
      rms: 0.01,
      silentForMs: 800,
    })).toBe(false)
    expect(reporter.shouldReport({
      audioActive: false,
      rms: 0.01,
      silentForMs: 900,
    })).toBe(true)
  })
})
