import { createDH2DPlayback } from './playback'

describe('createDH2DPlayback', () => {
  test('stores the latest audio status on playback.audioStatus', () => {
    const playback = createDH2DPlayback()
    const nextStatus = {
      state: 'running' as const,
      rms: 0.23,
      audioActive: true,
      silentForMs: 0,
      connectionSeq: 2,
      activitySeq: 5,
    }

    playback.setAudioStatus(nextStatus)

    expect(playback.audioStatus).toEqual(nextStatus)
  })

  test('observeAudioStatus notifies subscribers with new audio status values', () => {
    const playback = createDH2DPlayback()
    const observed: typeof playback.audioStatus[] = []
    const nextStatus = {
      state: 'running' as const,
      rms: 0.08,
      audioActive: false,
      silentForMs: 400,
      connectionSeq: 1,
      activitySeq: 3,
    }

    const unsubscribe = playback.observeAudioStatus((status) => {
      observed.push(status)
    })

    playback.setAudioStatus(nextStatus)
    unsubscribe()
    playback.setAudioStatus({
      ...nextStatus,
      activitySeq: 4,
      rms: 0.12,
      audioActive: true,
      silentForMs: 0,
    })

    expect(observed).toEqual([nextStatus])
  })

  test('resetAudioStatus returns playback to pending for a new connection', () => {
    const playback = createDH2DPlayback()

    playback.setAudioStatus({
      state: 'running',
      rms: 0.18,
      audioActive: true,
      silentForMs: 0,
      connectionSeq: 4,
      activitySeq: 9,
    })

    playback.resetAudioStatus(5)

    expect(playback.audioStatus).toEqual({
      state: 'pending',
      rms: 0,
      audioActive: false,
      silentForMs: 0,
      connectionSeq: 5,
      activitySeq: 0,
    })
  })

  test('markAudioStatusUnavailable clears stale running state after teardown', () => {
    const playback = createDH2DPlayback()

    playback.setAudioStatus({
      state: 'running',
      rms: 0.31,
      audioActive: true,
      silentForMs: 0,
      connectionSeq: 6,
      activitySeq: 11,
    })

    playback.markAudioStatusUnavailable(6)

    expect(playback.audioStatus).toEqual({
      state: 'unavailable',
      rms: 0,
      audioActive: false,
      silentForMs: 0,
      connectionSeq: 6,
      activitySeq: 0,
    })
  })
})
