import {
  createVoiceMessageAdapter,
  type VoiceClientEvent,
} from './adapter'

const sessionId = 'voice-session-1'

function createAdapter(onClientSend?: (frame: any) => void) {
  return createVoiceMessageAdapter({
    sessionId,
    onClientSend,
  })
}

function event(partial: { type: string } & Record<string, any>): VoiceClientEvent {
  return partial as VoiceClientEvent
}

describe('asr events become asr_process', () => {
  test('asr.partial becomes asr_process with completed false', () => {
    const adapter = createAdapter()
    expect(adapter.ingest(event({
      type: 'asr.partial', session_id: sessionId, turn_id: 't1', text: '你',
    }))).toEqual([
      { type: 'asr_process', sentence: '你', completed: false },
    ])
  })

  test('asr.final becomes asr_process with completed true', () => {
    const adapter = createAdapter()
    expect(adapter.ingest(event({
      type: 'asr.final', session_id: sessionId, turn_id: 't1', text: '你好',
    }))).toEqual([
      { type: 'asr_process', sentence: '你好', completed: true },
    ])
  })

  test('stale asr.partial from a retired turn never reaches the app', () => {
    const adapter = createAdapter()
    adapter.ingest(event({ type: 'assistant.text', session_id: sessionId, turn_id: 't1', text: 'x' }))
    adapter.ingest(event({ type: 'turn.end', session_id: sessionId, turn_id: 't1' }))
    expect(adapter.ingest(event({
      type: 'asr.partial', session_id: sessionId, turn_id: 't1', text: 'late',
    }))).toEqual([])
  })

  test('stale asr.final from a retired turn never reaches the app', () => {
    const adapter = createAdapter()
    adapter.ingest(event({ type: 'assistant.text', session_id: sessionId, turn_id: 't1', text: 'x' }))
    adapter.ingest(event({ type: 'turn.end', session_id: sessionId, turn_id: 't1' }))
    expect(adapter.ingest(event({
      type: 'asr.final', session_id: sessionId, turn_id: 't1', text: 'late',
    }))).toEqual([])
  })

  test('asr events without a turn id are not fenced', () => {
    const adapter = createAdapter()
    adapter.ingest(event({ type: 'turn.end', session_id: sessionId, turn_id: 't1' }))
    expect(adapter.ingest(event({
      type: 'asr.final', session_id: sessionId, text: '你好',
    }))).toEqual([
      { type: 'asr_process', sentence: '你好', completed: true },
    ])
  })
})

describe('assistant.text becomes bot_output and accumulates per turn', () => {
  test('each fragment is emitted as bot_output', () => {
    const adapter = createAdapter()
    expect(adapter.ingest(event({
      type: 'assistant.text', session_id: sessionId, turn_id: 't1', text: '你好',
    }))).toEqual([
      { type: 'bot_output', text: '你好' },
    ])
    expect(adapter.ingest(event({
      type: 'assistant.text', session_id: sessionId, turn_id: 't1', text: '，世界',
    }))).toEqual([
      { type: 'bot_output', text: '，世界' },
    ])
  })

  test('fragments accumulate independently per turn', () => {
    const adapter = createAdapter()
    adapter.ingest(event({ type: 'assistant.text', session_id: sessionId, turn_id: 't1', text: 'a' }))
    adapter.ingest(event({ type: 'assistant.text', session_id: sessionId, turn_id: 't2', text: 'b' }))
    adapter.ingest(event({ type: 'turn.end', session_id: sessionId, turn_id: 't1' }))
    expect(adapter.ingest(event({ type: 'turn.end', session_id: sessionId, turn_id: 't2' }))).toEqual([
      { type: 'message_record', message: { role: 'assistant', content: 'b' } },
    ])
  })

  test('fragments never become audio_text', () => {
    const adapter = createAdapter()
    const messages = adapter.ingest(event({
      type: 'assistant.text', session_id: sessionId, turn_id: 't1', text: '答案',
    }))
    expect(messages.some(m => m.type === 'audio_text')).toBe(false)
  })
})

describe('audio.chunk subtitles become audio_text in segment order', () => {
  test('main and narrator segments are emitted in order', () => {
    const adapter = createAdapter()
    expect(adapter.ingest(event({
      type: 'audio.chunk', session_id: sessionId, turn_id: 't1',
      subtitles: [
        { source: 'main', text: '回答内容' },
        { source: 'narrator', text: '我先查一下。' },
      ],
    }))).toEqual([
      { type: 'audio_text', text: '回答内容' },
      { type: 'audio_text', text: '我先查一下。' },
    ])
  })

  test('audio.chunk without subtitles emits nothing', () => {
    const adapter = createAdapter()
    expect(adapter.ingest(event({
      type: 'audio.chunk', session_id: sessionId, turn_id: 't1', byte_count: 4,
    }))).toEqual([])
  })

  test('unknown subtitle sources are not converted', () => {
    const adapter = createAdapter()
    expect(adapter.ingest(event({
      type: 'audio.chunk', session_id: sessionId, turn_id: 't1',
      subtitles: [{ source: 'unexpected', text: 'x' }] as any,
    }))).toEqual([])
  })

  test('late subtitles from a retired turn never reach the app', () => {
    const adapter = createAdapter()
    adapter.ingest(event({ type: 'assistant.text', session_id: sessionId, turn_id: 't1', text: 'x' }))
    adapter.ingest(event({ type: 'turn.end', session_id: sessionId, turn_id: 't1' }))
    expect(adapter.ingest(event({
      type: 'audio.chunk', session_id: sessionId, turn_id: 't1',
      subtitles: [{ source: 'main', text: 'late spoken' }],
    }))).toEqual([])
  })

  test('subtitles without a turn id are not fenced', () => {
    const adapter = createAdapter()
    expect(adapter.ingest(event({
      type: 'audio.chunk', session_id: sessionId,
      subtitles: [{ source: 'main', text: 'hi' }],
    }))).toEqual([
      { type: 'audio_text', text: 'hi' },
    ])
  })
})

describe('turn.end derives message_record from accumulated bot_output', () => {
  test('joined fragments become one assistant message_record', () => {
    const adapter = createAdapter()
    adapter.ingest(event({ type: 'assistant.text', session_id: sessionId, turn_id: 't1', text: '第一' }))
    adapter.ingest(event({ type: 'assistant.text', session_id: sessionId, turn_id: 't1', text: '第二' }))
    expect(adapter.ingest(event({ type: 'turn.end', session_id: sessionId, turn_id: 't1' }))).toEqual([
      { type: 'message_record', message: { role: 'assistant', content: '第一第二' } },
    ])
  })

  test('a turn with no assistant text invents no content', () => {
    const adapter = createAdapter()
    expect(adapter.ingest(event({ type: 'turn.end', session_id: sessionId, turn_id: 't1' }))).toEqual([])
  })

  test('duplicate turn.end emits no duplicate record', () => {
    const adapter = createAdapter()
    adapter.ingest(event({ type: 'assistant.text', session_id: sessionId, turn_id: 't1', text: 'x' }))
    adapter.ingest(event({ type: 'turn.end', session_id: sessionId, turn_id: 't1' }))
    expect(adapter.ingest(event({ type: 'turn.end', session_id: sessionId, turn_id: 't1' }))).toEqual([])
  })

  test('a failed turn keeps its accumulated apology text', () => {
    const adapter = createAdapter()
    adapter.ingest(event({ type: 'assistant.text', session_id: sessionId, turn_id: 't1', text: '抱歉，出错了' }))
    expect(adapter.ingest(event({ type: 'turn.end', session_id: sessionId, turn_id: 't1' }))).toEqual([
      { type: 'message_record', message: { role: 'assistant', content: '抱歉，出错了' } },
    ])
  })

  test('late assistant.text from a retired turn never reaches the app', () => {
    const adapter = createAdapter()
    adapter.ingest(event({ type: 'assistant.text', session_id: sessionId, turn_id: 't1', text: 'x' }))
    adapter.ingest(event({ type: 'turn.end', session_id: sessionId, turn_id: 't1' }))
    expect(adapter.ingest(event({ type: 'assistant.text', session_id: sessionId, turn_id: 't1', text: 'late' }))).toEqual([])
    expect(adapter.ingest(event({ type: 'turn.end', session_id: sessionId, turn_id: 't1' }))).toEqual([])
  })

  test('reset drops fragments from the previous connection generation', () => {
    const adapter = createAdapter()
    adapter.ingest(event({ type: 'assistant.text', session_id: sessionId, turn_id: 't1', text: 'old' }))
    adapter.reset()
    expect(adapter.ingest(event({ type: 'turn.end', session_id: sessionId, turn_id: 't1' }))).toEqual([])
  })
})

describe('status events become status_change', () => {
  test('capture.start becomes listening', () => {
    const adapter = createAdapter()
    expect(adapter.ingest(event({
      type: 'capture.start', session_id: sessionId, turn_id: 't1',
    }))).toEqual([
      { type: 'status_change', status: 'listening' },
    ])
  })

  test('capture.stop becomes talking while the conversation is active', () => {
    const adapter = createAdapter()
    adapter.ingest(event({ type: 'conversation.state', session_id: sessionId, state: 'voice' }))
    expect(adapter.ingest(event({
      type: 'capture.stop', session_id: sessionId, turn_id: 't1',
    }))).toEqual([
      { type: 'status_change', status: 'talking' },
    ])
  })

  test('capture.stop after the conversation ended emits no talking status', () => {
    const adapter = createAdapter()
    adapter.ingest(event({ type: 'conversation.state', session_id: sessionId, state: 'voice' }))
    adapter.ingest(event({ type: 'conversation.state', session_id: sessionId, state: 'ended' }))
    expect(adapter.ingest(event({
      type: 'capture.stop', session_id: sessionId, turn_id: 't1',
    }))).toEqual([])
  })

  test('conversation.state ended becomes sleeping', () => {
    const adapter = createAdapter()
    expect(adapter.ingest(event({
      type: 'conversation.state', session_id: sessionId, state: 'ended',
    }))).toEqual([
      { type: 'status_change', status: 'sleeping' },
    ])
  })

  test('conversation.state voice emits no status_change', () => {
    const adapter = createAdapter()
    expect(adapter.ingest(event({
      type: 'conversation.state', session_id: sessionId, state: 'voice',
    }))).toEqual([])
  })
})

describe('retired-turn fencing of capture events', () => {
  function retiredTurn(adapter: ReturnType<typeof createAdapter>, turnId: string) {
    adapter.ingest(event({ type: 'assistant.text', session_id: sessionId, turn_id: turnId, text: 'x' }))
    adapter.ingest(event({ type: 'turn.end', session_id: sessionId, turn_id: turnId }))
  }

  test('late capture.start for a retired turn never replaces the accepted capture turn', () => {
    const adapter = createAdapter()
    retiredTurn(adapter, 't1')
    adapter.ingest(event({ type: 'capture.start', session_id: sessionId, turn_id: 't2' }))
    expect(adapter.ingest(event({
      type: 'capture.start', session_id: sessionId, turn_id: 't1',
    }))).toEqual([])
    expect(adapter.audioInput(new Uint8Array([1]))).toEqual(expect.objectContaining({
      control: expect.objectContaining({ turn_id: 't2' }),
    }))
  })

  test('late capture.start for a retired turn emits no listening status', () => {
    const adapter = createAdapter()
    retiredTurn(adapter, 't1')
    expect(adapter.ingest(event({
      type: 'capture.start', session_id: sessionId, turn_id: 't1',
    }))).toEqual([])
  })

  test('late capture.stop for a retired turn emits no talking status', () => {
    const adapter = createAdapter()
    adapter.ingest(event({ type: 'conversation.state', session_id: sessionId, state: 'voice' }))
    retiredTurn(adapter, 't1')
    expect(adapter.ingest(event({
      type: 'capture.stop', session_id: sessionId, turn_id: 't1',
    }))).toEqual([])
  })

  test('late capture.stop for a retired turn releases only the matching capture turn', () => {
    const adapter = createAdapter()
    adapter.ingest(event({ type: 'capture.start', session_id: sessionId, turn_id: 't1' }))
    retiredTurn(adapter, 't1')
    adapter.ingest(event({ type: 'capture.stop', session_id: sessionId, turn_id: 't1' }))
    expect(adapter.audioInput(new Uint8Array([1]))).toBeNull()
  })

  test('late capture.stop for a retired turn keeps a newer capture turn accepted', () => {
    const adapter = createAdapter()
    retiredTurn(adapter, 't1')
    adapter.ingest(event({ type: 'capture.start', session_id: sessionId, turn_id: 't2' }))
    adapter.ingest(event({ type: 'conversation.state', session_id: sessionId, state: 'voice' }))
    expect(adapter.ingest(event({
      type: 'capture.stop', session_id: sessionId, turn_id: 't1',
    }))).toEqual([])
    expect(adapter.audioInput(new Uint8Array([1]))).toEqual(expect.objectContaining({
      control: expect.objectContaining({ turn_id: 't2' }),
    }))
  })
})

describe('SDK actions translate to client frames', () => {
  test('startFrame produces session.start with protocol version 2', () => {
    const adapter = createAdapter()
    expect(adapter.startFrame()).toEqual({
      type: 'session.start', session_id: sessionId, protocol_version: 2,
    })
  })

  test('sleep sends conversation.stop', () => {
    const adapter = createAdapter()
    expect(adapter.sleep()).toEqual([
      { type: 'conversation.stop', session_id: sessionId },
    ])
  })

  test('wakeup while inactive sends conversation.start immediately', () => {
    const adapter = createAdapter()
    expect(adapter.wakeup()).toEqual([
      { type: 'conversation.start', session_id: sessionId },
    ])
  })

  test('wakeup while active stops, waits for the ended boundary, then starts', () => {
    const sent: any[] = []
    const adapter = createAdapter(frame => sent.push(frame))
    adapter.ingest(event({ type: 'conversation.state', session_id: sessionId, state: 'voice' }))
    expect(adapter.wakeup()).toEqual([
      { type: 'conversation.stop', session_id: sessionId },
    ])
    expect(sent).toEqual([])
    adapter.ingest(event({ type: 'conversation.state', session_id: sessionId, state: 'ended' }))
    expect(sent).toEqual([
      { type: 'conversation.start', session_id: sessionId },
    ])
  })

  test('wakeup with text sends conversation.start then text.input, never a stop', () => {
    const adapter = createAdapter()
    const frames = adapter.wakeup('你好') as any[]
    expect(frames).toHaveLength(2)
    expect(frames[0]).toEqual({ type: 'conversation.start', session_id: sessionId })
    expect(frames[1].type).toBe('text.input')
    expect(frames[1].session_id).toBe(sessionId)
    expect(frames[1].text).toBe('你好')
    expect(typeof frames[1].request_id).toBe('string')
    expect(frames[1].request_id.length).toBeGreaterThan(0)
    expect(frames.some(frame => frame.type === 'conversation.stop')).toBe(false)
  })

  test('wakeup with text never stops even while the conversation is active', () => {
    const sent: any[] = []
    const adapter = createAdapter(frame => sent.push(frame))
    adapter.ingest(event({ type: 'conversation.state', session_id: sessionId, state: 'voice' }))
    expect((adapter.wakeup('你好') as any[]).map(frame => frame.type)).toEqual([
      'conversation.start', 'text.input',
    ])
    adapter.ingest(event({ type: 'conversation.state', session_id: sessionId, state: 'ended' }))
    expect(sent).toEqual([])
  })

  test('wakeup with blank text keeps the no-text wakeup behavior', () => {
    const adapter = createAdapter()
    expect(adapter.wakeup('   ')).toEqual([
      { type: 'conversation.start', session_id: sessionId },
    ])
  })

  test('wakeup with text interrupts a pending wakeup start', () => {
    const sent: any[] = []
    const adapter = createAdapter(frame => sent.push(frame))
    adapter.ingest(event({ type: 'conversation.state', session_id: sessionId, state: 'voice' }))
    adapter.wakeup()
    expect((adapter.wakeup('你好') as any[]).map(frame => frame.type)).toEqual([
      'conversation.start', 'text.input',
    ])
    adapter.ingest(event({ type: 'conversation.state', session_id: sessionId, state: 'ended' }))
    expect(sent).toEqual([])
  })

  test('a second wakeup while a stop-then-start is pending does not double start', () => {
    const sent: any[] = []
    const adapter = createAdapter(frame => sent.push(frame))
    adapter.ingest(event({ type: 'conversation.state', session_id: sessionId, state: 'voice' }))
    adapter.wakeup()
    adapter.wakeup()
    adapter.ingest(event({ type: 'conversation.state', session_id: sessionId, state: 'ended' }))
    expect(sent).toEqual([
      { type: 'conversation.start', session_id: sessionId },
    ])
  })

  test('sleep cancels a pending wakeup start', () => {
    const sent: any[] = []
    const adapter = createAdapter(frame => sent.push(frame))
    adapter.ingest(event({ type: 'conversation.state', session_id: sessionId, state: 'voice' }))
    adapter.wakeup()
    adapter.sleep()
    adapter.ingest(event({ type: 'conversation.state', session_id: sessionId, state: 'ended' }))
    expect(sent).toEqual([])
  })

  test('text input maps to text.input with request_id and without turn_id', () => {
    const adapter = createAdapter()
    const frame = adapter.textInput('你好') as any
    expect(frame.type).toBe('text.input')
    expect(frame.session_id).toBe(sessionId)
    expect(frame.text).toBe('你好')
    expect(typeof frame.request_id).toBe('string')
    expect(frame.request_id.length).toBeGreaterThan(0)
    expect(frame.turn_id).toBeUndefined()
  })

  test('text input request ids are unique', () => {
    const adapter = createAdapter()
    const first = adapter.textInput('a') as any
    const second = adapter.textInput('b') as any
    expect(first.request_id).not.toBe(second.request_id)
  })

  test('microphone PCM maps to an input audio.chunk control frame plus binary', () => {
    const adapter = createAdapter()
    adapter.ingest(event({ type: 'capture.start', session_id: sessionId, turn_id: 't9' }))
    const bytes = new Uint8Array([1, 2, 3, 4])
    expect(adapter.audioInput(bytes)).toEqual({
      control: {
        type: 'audio.chunk', direction: 'input',
        session_id: sessionId, turn_id: 't9', byte_count: 4,
      },
      binary: bytes,
    })
  })

  test('microphone PCM without an accepted capture turn is refused', () => {
    const adapter = createAdapter()
    expect(adapter.audioInput(new Uint8Array([1]))).toBeNull()
  })

  test('capture.stop retires the capture turn for audio input', () => {
    const adapter = createAdapter()
    adapter.ingest(event({ type: 'capture.start', session_id: sessionId, turn_id: 't9' }))
    adapter.ingest(event({ type: 'capture.stop', session_id: sessionId, turn_id: 't9' }))
    expect(adapter.audioInput(new Uint8Array([1]))).toBeNull()
  })

  test('playbackEnded maps to the playback.ended client frame', () => {
    const adapter = createAdapter()
    expect(adapter.playbackEnded('A0')).toEqual({
      type: 'playback.ended', session_id: sessionId, turn_id: 'A0',
    })
  })

  test('config frames are ignored', () => {
    const adapter = createAdapter()
    expect(adapter.wakeup()).toBeDefined()
  })
})

describe('asr_session maps to the conversation lifecycle that owns listening', () => {
  test('asr_session start sends conversation.start', () => {
    const adapter = createAdapter()
    expect(adapter.asrSession('start')).toEqual([
      { type: 'conversation.start', session_id: sessionId },
    ])
  })

  test('asr_session start sends conversation.start even while the conversation is active', () => {
    const adapter = createAdapter()
    adapter.ingest(event({ type: 'conversation.state', session_id: sessionId, state: 'voice' }))
    expect(adapter.asrSession('start')).toEqual([
      { type: 'conversation.start', session_id: sessionId },
    ])
  })

  test('asr_session stop sends conversation.stop', () => {
    const adapter = createAdapter()
    expect(adapter.asrSession('stop')).toEqual([
      { type: 'conversation.stop', session_id: sessionId },
    ])
  })

  test('asr_session stop cancels a pending wakeup start', () => {
    const sent: any[] = []
    const adapter = createAdapter(frame => sent.push(frame))
    adapter.ingest(event({ type: 'conversation.state', session_id: sessionId, state: 'voice' }))
    adapter.wakeup()
    expect(adapter.asrSession('stop')).toEqual([
      { type: 'conversation.stop', session_id: sessionId },
    ])
    adapter.ingest(event({ type: 'conversation.state', session_id: sessionId, state: 'ended' }))
    expect(sent).toEqual([])
  })
})

describe('sleep with text', () => {
  test('sleep with text sends only text.input and defers the stop', () => {
    const adapter = createAdapter()
    const frames = adapter.sleep('再见') as any[]
    expect(frames).toHaveLength(1)
    expect(frames[0].type).toBe('text.input')
    expect(frames[0].session_id).toBe(sessionId)
    expect(frames[0].text).toBe('再见')
    expect(typeof frames[0].request_id).toBe('string')
    expect(frames[0].request_id.length).toBeGreaterThan(0)
  })

  test('sleep with blank text keeps the immediate conversation.stop', () => {
    const adapter = createAdapter()
    expect(adapter.sleep('  ')).toEqual([
      { type: 'conversation.stop', session_id: sessionId },
    ])
  })

  test('sleep with text interrupts a pending wakeup start', () => {
    const sent: any[] = []
    const adapter = createAdapter(frame => sent.push(frame))
    adapter.ingest(event({ type: 'conversation.state', session_id: sessionId, state: 'voice' }))
    adapter.wakeup()
    adapter.sleep('再见')
    adapter.ingest(event({ type: 'conversation.state', session_id: sessionId, state: 'ended' }))
    expect(sent).toEqual([])
  })

  test('text.accepted for the sleep text emits no app-facing message', () => {
    const adapter = createAdapter()
    const frame = (adapter.sleep('再见') as any[])[0]
    expect(adapter.ingest(event({
      type: 'text.accepted', session_id: sessionId, request_id: frame.request_id, turn_id: 'A1',
    }))).toEqual([])
  })

  test('text.accepted for another session or an unknown request emits no app-facing message', () => {
    const adapter = createAdapter()
    const frame = (adapter.sleep('再见') as any[])[0]
    expect(adapter.ingest(event({
      type: 'text.accepted', session_id: 'other-session', request_id: frame.request_id, turn_id: 'A1',
    }))).toEqual([])
    expect(adapter.ingest(event({
      type: 'text.accepted', session_id: sessionId, request_id: 'unknown-request', turn_id: 'A1',
    }))).toEqual([])
  })
})

describe('pending message sequencing interruption', () => {
  function armPendingWakeupStart(adapter: ReturnType<typeof createAdapter>) {
    adapter.ingest(event({ type: 'conversation.state', session_id: sessionId, state: 'voice' }))
    expect(adapter.wakeup()).toEqual([
      { type: 'conversation.stop', session_id: sessionId },
    ])
  }

  test('a new text input interrupts a pending wakeup start', () => {
    const sent: any[] = []
    const adapter = createAdapter(frame => sent.push(frame))
    armPendingWakeupStart(adapter)
    adapter.textInput('new input')
    adapter.ingest(event({ type: 'conversation.state', session_id: sessionId, state: 'ended' }))
    expect(sent).toEqual([])
  })

  test('a new asr_session start interrupts a pending wakeup start', () => {
    const sent: any[] = []
    const adapter = createAdapter(frame => sent.push(frame))
    armPendingWakeupStart(adapter)
    expect(adapter.asrSession('start')).toEqual([
      { type: 'conversation.start', session_id: sessionId },
    ])
    adapter.ingest(event({ type: 'conversation.state', session_id: sessionId, state: 'ended' }))
    expect(sent).toEqual([])
  })

  test('reset interrupts a pending wakeup start', () => {
    const sent: any[] = []
    const adapter = createAdapter(frame => sent.push(frame))
    armPendingWakeupStart(adapter)
    adapter.reset()
    adapter.ingest(event({ type: 'conversation.state', session_id: sessionId, state: 'ended' }))
    expect(sent).toEqual([])
  })
})

describe('sleep with text waits for the avatar turn transition', () => {
  function sentStops(sent: any[]) {
    return sent.filter(frame => frame.type === 'conversation.stop')
  }

  function armPendingSleep(adapter: ReturnType<typeof createAdapter>) {
    const frame = (adapter.sleep('再见') as any[])[0]
    adapter.ingest(event({
      type: 'text.accepted', session_id: sessionId, request_id: frame.request_id, turn_id: 'A1',
    }))
    return frame.request_id as string
  }

  test('stops once after the accepted turn is observed and then a different valid turn follows', () => {
    const sent: any[] = []
    const adapter = createAdapter(frame => sent.push(frame))
    armPendingSleep(adapter)
    adapter.observeAvatarTurn('B0')
    adapter.observeAvatarTurn('A1')
    adapter.observeAvatarTurn('A1')
    expect(sent).toEqual([])
    adapter.observeAvatarTurn('B2')
    expect(sentStops(sent)).toEqual([
      { type: 'conversation.stop', session_id: sessionId },
    ])
    // The sequence completed; later transitions never send a second stop.
    adapter.observeAvatarTurn('C3')
    expect(sentStops(sent)).toHaveLength(1)
  })

  test('no stop while the accepted turn has not appeared in avatar playback', () => {
    const sent: any[] = []
    const adapter = createAdapter(frame => sent.push(frame))
    armPendingSleep(adapter)
    adapter.observeAvatarTurn('B2')
    adapter.observeAvatarTurn('C3')
    expect(sent).toEqual([])
  })

  test('no stop while the current turn remains the accepted turn', () => {
    const sent: any[] = []
    const adapter = createAdapter(frame => sent.push(frame))
    armPendingSleep(adapter)
    adapter.observeAvatarTurn('A1')
    adapter.observeAvatarTurn('A1')
    adapter.observeAvatarTurn('A1')
    expect(sent).toEqual([])
  })

  test('a duplicate acknowledgement keeps the first accepted turn', () => {
    const sent: any[] = []
    const adapter = createAdapter(frame => sent.push(frame))
    const frame = (adapter.sleep('再见') as any[])[0]
    adapter.ingest(event({
      type: 'text.accepted', session_id: sessionId, request_id: frame.request_id, turn_id: 'A1',
    }))
    adapter.ingest(event({
      type: 'text.accepted', session_id: sessionId, request_id: frame.request_id, turn_id: 'A2',
    }))
    adapter.observeAvatarTurn('A1')
    adapter.observeAvatarTurn('A2')
    expect(sentStops(sent)).toEqual([
      { type: 'conversation.stop', session_id: sessionId },
    ])
  })

  test('a new input interrupts the pending sleep sequence', () => {
    const sent: any[] = []
    const adapter = createAdapter(frame => sent.push(frame))
    armPendingSleep(adapter)
    adapter.textInput('hold on')
    adapter.observeAvatarTurn('A1')
    adapter.observeAvatarTurn('B2')
    expect(sent).toEqual([])
  })

  test('a new wakeup interrupts the pending sleep sequence', () => {
    const sent: any[] = []
    const adapter = createAdapter(frame => sent.push(frame))
    armPendingSleep(adapter)
    adapter.wakeup()
    adapter.observeAvatarTurn('A1')
    adapter.observeAvatarTurn('B2')
    expect(sent).toEqual([])
  })

  test('a new sleep with text replaces the pending sleep sequence', () => {
    const sent: any[] = []
    const adapter = createAdapter(frame => sent.push(frame))
    armPendingSleep(adapter)
    const frame = (adapter.sleep('另一句') as any[])[0]
    // The retired sequence's accepted turn and transition never stop.
    adapter.observeAvatarTurn('A1')
    adapter.observeAvatarTurn('B2')
    expect(sent).toEqual([])
    // The replacement sequence still completes on its own acknowledgement.
    adapter.ingest(event({
      type: 'text.accepted', session_id: sessionId, request_id: frame.request_id, turn_id: 'C3',
    }))
    adapter.observeAvatarTurn('C3')
    adapter.observeAvatarTurn('D4')
    expect(sentStops(sent)).toEqual([
      { type: 'conversation.stop', session_id: sessionId },
    ])
  })

  test('reset retires the pending sleep sequence', () => {
    const sent: any[] = []
    const adapter = createAdapter(frame => sent.push(frame))
    armPendingSleep(adapter)
    adapter.reset()
    adapter.observeAvatarTurn('A1')
    adapter.observeAvatarTurn('B2')
    expect(sent).toEqual([])
  })

  test('an acknowledgement after reset never arms the old sequence', () => {
    const sent: any[] = []
    const adapter = createAdapter(frame => sent.push(frame))
    const frame = (adapter.sleep('再见') as any[])[0]
    adapter.reset()
    adapter.ingest(event({
      type: 'text.accepted', session_id: sessionId, request_id: frame.request_id, turn_id: 'A1',
    }))
    adapter.observeAvatarTurn('A1')
    adapter.observeAvatarTurn('B2')
    expect(sent).toEqual([])
  })

  test('avatar observations before the accepted turn correlate nothing', () => {
    const sent: any[] = []
    const adapter = createAdapter(frame => sent.push(frame))
    const frame = (adapter.sleep('再见') as any[])[0]
    adapter.observeAvatarTurn('A1')
    adapter.observeAvatarTurn('B2')
    adapter.ingest(event({
      type: 'text.accepted', session_id: sessionId, request_id: frame.request_id, turn_id: 'A1',
    }))
    adapter.observeAvatarTurn('A1')
    adapter.observeAvatarTurn('B2')
    expect(sentStops(sent)).toEqual([
      { type: 'conversation.stop', session_id: sessionId },
    ])
  })
})

describe('other client events', () => {
  test('dh_2d_session_ready is surfaced and produces no app message', () => {
    const adapter = createAdapter()
    expect(adapter.ingest(event({
      type: 'dh_2d_session_ready', session_id: 'canonical-avatar',
    }))).toEqual([])
  })

  test('session.state and text.accepted produce no app message', () => {
    const adapter = createAdapter()
    expect(adapter.ingest(event({
      type: 'session.state', session_id: sessionId, state: 'connected',
    }))).toEqual([])
    expect(adapter.ingest(event({
      type: 'text.accepted', session_id: sessionId, turn_id: 't1', request_id: 'r1',
    }))).toEqual([])
  })

  test('playback.stop produces no app message', () => {
    const adapter = createAdapter()
    expect(adapter.ingest(event({
      type: 'playback.stop', session_id: sessionId, turn_id: 't1',
    }))).toEqual([])
  })

  test('unknown events are ignored', () => {
    const adapter = createAdapter()
    expect(adapter.ingest(event({ type: 'diagnostics', session_id: sessionId }))).toEqual([])
  })

  test('events for a different voice session are ignored', () => {
    const adapter = createAdapter()
    expect(adapter.ingest(event({
      type: 'assistant.text', session_id: 'other-session', turn_id: 't1', text: 'x',
    }))).toEqual([])
    expect(adapter.ingest(event({
      type: 'turn.end', session_id: 'other-session', turn_id: 't1',
    }))).toEqual([])
  })
})
