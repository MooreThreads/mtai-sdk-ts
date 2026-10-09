import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

test('mtai package no longer exports playback audio monitoring symbols', () => {
  const require = createRequire(import.meta.url)
  const mtai = require('mtai') as Record<string, unknown>
  assert.equal(mtai.DH2DPlaybackAudioStatusState, undefined)
  assert.equal(mtai.createDH2DPlayback, undefined)
})

test('dh2d connection path contains no web-audio activity detector', () => {
  const source = readFileSync(here('../../../core/src/dh2d/connections.ts'), 'utf8')
  for (const marker of [
    'AudioContext',
    'createAnalyser',
    'dh_2d_audio_activity',
    'calculateRms',
    'startAudioActivityMonitoring',
  ]) {
    assert.equal(source.includes(marker), false, `connections.ts still references ${marker}`)
  }
})

test('react demo no longer wires playback audio monitoring or silence analysis', () => {
  for (const file of ['App.tsx', 'dh2d.tsx']) {
    const source = readFileSync(here('./' + file), 'utf8')
    for (const marker of [
      'DH2DPlaybackAudioStatus',
      'onAudioStatusChanged',
      'audioStatus',
      'playbackAnalysis',
      'Playback Audio',
      'Silence400',
    ]) {
      assert.equal(source.includes(marker), false, `${file} still references ${marker}`)
    }
  }
})

test('dedicated audio activity and silence analysis modules are removed', () => {
  for (const file of [
    './playbackAnalysis.ts',
    './playbackAnalysis.test.ts',
    '../../../core/src/dh2d/audioActivity.ts',
    '../../../core/src/dh2d/audioActivity.test.ts',
    '../../../core/src/dh2d/playback.ts',
    '../../../core/src/dh2d/playback.test.ts',
  ]) {
    assert.equal(existsSync(here(file)), false, `${file} must be removed`)
  }
})
