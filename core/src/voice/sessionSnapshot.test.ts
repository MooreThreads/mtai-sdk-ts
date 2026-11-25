import { createSessionSnapshotProjection } from './sessionSnapshot'

test('source-independent capture indicator, revision fencing, and replay are pure', () => {
  const projection = createSessionSnapshotProjection('s')
  const event = { type: 'session.snapshot', session_id: 's', state_epoch: 'e', revision: 1,
    state: { conversation: { state: 'voice', phase: 'capturing' },
      audio_input: { source: 'xunfei', status: 'capturing', source_revision: 2, capture_turn_id: 'A' } } }
  expect(projection.ingest(event)).toEqual([{ type: 'status_change', status: 'listening' }])
  expect(projection.ingest(event)).toEqual([])
  expect(projection.ingest({ ...event, state_epoch: 'old', revision: 99 })).toEqual([])
  expect(projection.replay()).toEqual([{ type: 'status_change', status: 'listening' }])
  const waiting = JSON.parse(JSON.stringify(event))
  waiting.revision = 2
  waiting.state.conversation.phase = 'waiting_playback'
  waiting.state.audio_input.status = 'ready'
  waiting.state.audio_input.capture_turn_id = null
  expect(projection.ingest(waiting)).toEqual([{ type: 'status_change', status: 'talking' }])
})

test('projects trusted tts_error provider_failure and ignores untrusted values', () => {
  const projection = createSessionSnapshotProjection('s')
  const base = {
    type: 'session.snapshot',
    session_id: 's',
    state_epoch: 'e',
    state: {
      conversation: { state: 'ended', phase: 'idle' },
      audio_input: { source: 'xunfei', status: 'ready', source_revision: 1, capture_turn_id: null },
    },
  }
  projection.ingest({ ...base, revision: 1, state: { ...base.state, tts_error: 'raw_error' } })
  expect(projection.snapshot()?.state.tts_error).toBeUndefined()
  projection.ingest({ ...base, revision: 2, state: { ...base.state, tts_error: 'provider_failure' } })
  expect(projection.snapshot()?.state.tts_error).toBe('provider_failure')
  projection.ingest({ ...base, revision: 3 })
  expect(projection.snapshot()?.state.tts_error).toBeUndefined()
})
