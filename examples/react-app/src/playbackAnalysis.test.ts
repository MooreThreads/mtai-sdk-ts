import test from 'node:test'
import assert from 'node:assert/strict'

import type { DH2DPlaybackAudioStatus } from 'mtai'
import { advancePlaybackAnalysis, createInitialPlaybackAnalysis } from './playbackAnalysis.ts'

function audioStatus(overrides: Partial<DH2DPlaybackAudioStatus>): DH2DPlaybackAudioStatus {
  return {
    state: 'running',
    rms: 0,
    audioActive: false,
    silentForMs: 0,
    connectionSeq: 0,
    activitySeq: 0,
    ...overrides,
  }
}

test('computes listening delay from silence-400 threshold crossing', () => {
  let analysis = createInitialPlaybackAnalysis()

  analysis = advancePlaybackAnalysis(analysis, {
    status: 'talking',
    audioStatus: audioStatus({ audioActive: true, silentForMs: 0 }),
    nowMs: 1000,
  })
  assert.equal(analysis.latestListeningDelayMs, null)
  assert.equal(analysis.silenceThresholdReachedAtMs, null)

  analysis = advancePlaybackAnalysis(analysis, {
    status: 'talking',
    audioStatus: audioStatus({ audioActive: false, silentForMs: 500, activitySeq: 1 }),
    nowMs: 1800,
  })
  assert.equal(analysis.silenceThresholdReachedAtMs, 1700)
  assert.equal(analysis.latestListeningDelayMs, null)

  analysis = advancePlaybackAnalysis(analysis, {
    status: 'listening',
    audioStatus: audioStatus({ audioActive: false, silentForMs: 600, activitySeq: 2 }),
    nowMs: 1930,
  })
  assert.equal(analysis.latestListeningDelayMs, 230)
  assert.equal(analysis.lastListeningAtMs, 1930)
})

test('resets pending silence timing when playback becomes active again', () => {
  let analysis = createInitialPlaybackAnalysis()

  analysis = advancePlaybackAnalysis(analysis, {
    status: 'talking',
    audioStatus: audioStatus({ audioActive: false, silentForMs: 450, activitySeq: 1 }),
    nowMs: 1450,
  })
  assert.equal(analysis.silenceThresholdReachedAtMs, 1400)

  analysis = advancePlaybackAnalysis(analysis, {
    status: 'talking',
    audioStatus: audioStatus({ audioActive: true, silentForMs: 0, activitySeq: 2 }),
    nowMs: 1500,
  })
  assert.equal(analysis.silenceThresholdReachedAtMs, null)
  assert.equal(analysis.latestListeningDelayMs, null)
})

test('marks the measurement invalid when listening starts before silence-400', () => {
  let analysis = createInitialPlaybackAnalysis()

  analysis = advancePlaybackAnalysis(analysis, {
    status: 'listening',
    audioStatus: audioStatus({ audioActive: false, silentForMs: 150, activitySeq: 1 }),
    nowMs: 1000,
  })
  assert.equal(analysis.latestListeningDelayMs, null)
  assert.equal(analysis.latestListeningError, 'listening started before silence-400')

  analysis = advancePlaybackAnalysis(analysis, {
    status: 'listening',
    audioStatus: audioStatus({ audioActive: false, silentForMs: 450, activitySeq: 2 }),
    nowMs: 1300,
  })
  assert.equal(analysis.silenceThresholdReachedAtMs, 1250)
  assert.equal(analysis.latestListeningDelayMs, null)
  assert.equal(analysis.latestListeningError, 'listening started before silence-400')
})

test('replaces a previous successful measurement with an immediate error on the next invalid cycle', () => {
  let analysis = createInitialPlaybackAnalysis()

  analysis = advancePlaybackAnalysis(analysis, {
    status: 'talking',
    audioStatus: audioStatus({ audioActive: false, silentForMs: 500, activitySeq: 1 }),
    nowMs: 1800,
  })

  analysis = advancePlaybackAnalysis(analysis, {
    status: 'listening',
    audioStatus: audioStatus({ audioActive: false, silentForMs: 600, activitySeq: 2 }),
    nowMs: 1930,
  })
  assert.equal(analysis.latestListeningDelayMs, 230)
  assert.equal(analysis.latestListeningError, null)

  analysis = advancePlaybackAnalysis(analysis, {
    status: 'talking',
    audioStatus: audioStatus({ audioActive: true, silentForMs: 0, activitySeq: 3 }),
    nowMs: 2400,
  })

  analysis = advancePlaybackAnalysis(analysis, {
    status: 'listening',
    audioStatus: audioStatus({ audioActive: false, silentForMs: 100, activitySeq: 4 }),
    nowMs: 2500,
  })
  assert.equal(analysis.latestListeningDelayMs, null)
  assert.equal(analysis.latestListeningError, 'listening started before silence-400')
})
