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
