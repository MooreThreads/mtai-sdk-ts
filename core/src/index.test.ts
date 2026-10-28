import * as mtai from './index'

test('binding UI workflows and observer options remain internal', () => {
  const exported = mtai as unknown as Record<string, unknown>
  expect(exported.createChannelBindingWorkflow).toBeUndefined()
  expect(exported.createChannelBindingToolHandler).toBeUndefined()
})

describe('public API audio monitoring removal', () => {
  test('no longer exports playback audio monitoring symbols', () => {
    const exported = mtai as unknown as Record<string, unknown>
    expect(exported.DH2DPlaybackAudioStatusState).toBeUndefined()
    expect(exported.createDH2DPlayback).toBeUndefined()
  })
})
