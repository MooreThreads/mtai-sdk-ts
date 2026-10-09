import * as mtai from './index'

describe('public API audio monitoring removal', () => {
  test('no longer exports playback audio monitoring symbols', () => {
    const exported = mtai as unknown as Record<string, unknown>
    expect(exported.DH2DPlaybackAudioStatusState).toBeUndefined()
    expect(exported.createDH2DPlayback).toBeUndefined()
  })
})
