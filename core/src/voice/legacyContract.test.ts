import { createVoiceMessageAdapter } from './adapter'

// Contract reference: Electron 9d1ce62^ src/renderer/page/dh2d.tsx:
// bot_output replaces its cache; audio_text appends history; asr_process is
// progress only, while message_record(user) confirms history without resending.
describe('legacy message contract', () => {
  const sessionId = 'legacy'
  const create = () => createVoiceMessageAdapter({ sessionId, requestIdFactory: () => 'request' })
  const frame = (type: string, extra = {}) => ({ type, session_id: sessionId, turn_id: 'turn', ...extra })

  test('ASR progress stays progress and final confirms user exactly once without asr_session resend', () => {
    const adapter = create()
    expect(adapter.ingest(frame('asr.partial', { text: '你' }))).toEqual([
      { type: 'asr_process', sentence: '你', completed: false },
    ])
    expect(adapter.ingest(frame('asr.final', { text: '你好' }))).toEqual([
      { type: 'asr_process', sentence: '你好', completed: true },
      { type: 'message_record', message: { role: 'user', content: '你好' } },
    ])
    expect(adapter.ingest(frame('asr.final', { text: '你好' }))).toEqual([])
    expect(adapter.ingest(frame('asr.partial', { text: '迟到' }))).toEqual([])
    adapter.reset()
    expect(adapter.ingest(frame('asr.final', { text: '' }))).toEqual([
      { type: 'asr_process', sentence: '', completed: true },
    ])
  })

  test('bot output replaces, spoken text increments in source order, final record contains full answer', () => {
    const adapter = create()
    expect(adapter.ingest(frame('text.output.delta', { text: '甲' }))).toEqual([{ type: 'bot_output', text: '甲' }])
    expect(adapter.ingest(frame('text.output.delta', { text: '乙' }))).toEqual([{ type: 'bot_output', text: '甲乙' }])
    expect(adapter.ingest(frame('audio.output.delta', { subtitles: [
      { source: 'narrator', text: '稍等。' }, { source: 'main', text: '甲' },
    ] }))).toEqual([{ type: 'audio_text', text: '稍等。' }, { type: 'audio_text', text: '甲' }])
    expect(adapter.ingest(frame('audio.output.delta', { subtitles: [{ source: 'main', text: '乙' }] })))
      .toEqual([{ type: 'audio_text', text: '乙' }])
    expect(adapter.ingest(frame('turn.end'))).toEqual([
      { type: 'message_record', message: { role: 'assistant', content: '甲乙' } },
    ])
  })

  test('successive spoken segments remain increments, not accumulated prefixes', () => {
    const adapter = create()
    adapter.ingest(frame('audio.output.delta', { subtitles: [{ source: 'main', text: '甲' }] }))
    expect(adapter.ingest(frame('audio.output.delta', { subtitles: [{ source: 'main', text: '乙' }] })))
      .toEqual([{ type: 'audio_text', text: '乙' }])
  })

  test('typed acknowledgement confirms original user text before explicit talking status, once', () => {
    const adapter = create()
    adapter.textInput('typed')
    expect(adapter.ingest(frame('text.accepted', { request_id: 'request' }))).toEqual([
      { type: 'message_record', message: { role: 'user', content: 'typed' } },
      { type: 'status_change', status: 'talking' },
    ])
    expect(adapter.ingest(frame('text.accepted', { request_id: 'request' }))).toEqual([])
  })
})
