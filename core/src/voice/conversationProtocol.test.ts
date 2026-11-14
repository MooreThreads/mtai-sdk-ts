import { sendVoiceClientMessage } from './conversationProtocol'
import { createVoiceMessageAdapter } from './adapter'
class ControlSocket { sent: string[] = []; send(value: string) { this.sent.push(value) } }
describe('sendVoiceClientMessage', () => {
  function setup() {
    const ws = new ControlSocket()
    const adapter = createVoiceMessageAdapter({ sessionId: 'voice-1' })
    return { ws, adapter }
  }

  test('wakeup while inactive sends conversation.start only', async () => {
    const { ws, adapter } = setup()
    await sendVoiceClientMessage(ws as any, adapter, { type: 'wakeup' })
    expect(ws.sent.map((d: string) => JSON.parse(d))).toEqual([
      { type: 'conversation.start', session_id: 'voice-1' },
    ])
  })

  test('wakeup with text sends conversation.start then text.input', async () => {
    const { ws, adapter } = setup()
    await sendVoiceClientMessage(ws as any, adapter, { type: 'wakeup', text: '你好' })
    const frames = ws.sent.map((d: string) => JSON.parse(d))
    expect(frames).toHaveLength(2)
    expect(frames[0]).toEqual({ type: 'conversation.start', session_id: 'voice-1' })
    expect(frames[1].type).toBe('text.input')
    expect(frames[1].session_id).toBe('voice-1')
    expect(frames[1].text).toBe('你好')
    expect(typeof frames[1].request_id).toBe('string')
    expect(frames[1].request_id.length).toBeGreaterThan(0)
  })

  test('wakeup with text sends both frames even while the conversation is active', async () => {
    const { ws, adapter } = setup()
    adapter.ingest({ type: 'conversation.state', session_id: 'voice-1', state: 'voice' })
    await sendVoiceClientMessage(ws as any, adapter, { type: 'wakeup', text: '你好' })
    expect(ws.sent.map((d: string) => JSON.parse(d)).map((f: any) => f.type)).toEqual([
      'conversation.start', 'text.input',
    ])
  })

  test('wakeup with blank text keeps the no-text wakeup behavior', async () => {
    const { ws, adapter } = setup()
    adapter.ingest({ type: 'conversation.state', session_id: 'voice-1', state: 'voice' })
    await sendVoiceClientMessage(ws as any, adapter, { type: 'wakeup', text: '   ' })
    expect(ws.sent.map((d: string) => JSON.parse(d))).toEqual([
      { type: 'conversation.start', session_id: 'voice-1' },
    ])
  })

  test('sleep sends conversation.stop', async () => {
    const { ws, adapter } = setup()
    await sendVoiceClientMessage(ws as any, adapter, { type: 'sleep' })
    expect(ws.sent.map((d: string) => JSON.parse(d))).toEqual([
      { type: 'conversation.stop', session_id: 'voice-1' },
    ])
  })

  test('sleep with text sends text.input only and defers the stop', async () => {
    const { ws, adapter } = setup()
    await sendVoiceClientMessage(ws as any, adapter, { type: 'sleep', text: '再见' })
    const frames = ws.sent.map((d: string) => JSON.parse(d))
    expect(frames).toHaveLength(1)
    expect(frames[0].type).toBe('text.input')
    expect(frames[0].session_id).toBe('voice-1')
    expect(frames[0].text).toBe('再见')
    expect(typeof frames[0].request_id).toBe('string')
  })

  test('sleep with blank text keeps the immediate conversation.stop', async () => {
    const { ws, adapter } = setup()
    await sendVoiceClientMessage(ws as any, adapter, { type: 'sleep', text: '  ' })
    expect(ws.sent.map((d: string) => JSON.parse(d))).toEqual([
      { type: 'conversation.stop', session_id: 'voice-1' },
    ])
  })

  test('text input sends text.input with request_id', async () => {
    const { ws, adapter } = setup()
    await sendVoiceClientMessage(ws as any, adapter, { type: 'input', text: 'hello' })
    const frame = JSON.parse(ws.sent[0])
    expect(frame.type).toBe('text.input')
    expect(frame.text).toBe('hello')
    expect(typeof frame.request_id).toBe('string')
  })

  test('input with bot_text is rejected instead of silently dropped', async () => {
    const { ws, adapter } = setup()
    await expect(sendVoiceClientMessage(ws as any, adapter, {
      type: 'input', bot_text: 'I will say exactly this text.',
    })).rejects.toThrow(/bot_text/)
    expect(ws.sent).toEqual([])
  })

  test('input with text and bot_text sends no frame before failing', async () => {
    const { ws, adapter } = setup()
    await expect(sendVoiceClientMessage(ws as any, adapter, {
      type: 'input', text: 'hello', bot_text: 'verbatim',
    })).rejects.toThrow(/bot_text/)
    expect(ws.sent).toEqual([])
  })

  function setupPendingSleep() {
    const ws = new ControlSocket()
    const deferred: any[] = []
    const adapter = createVoiceMessageAdapter({
      sessionId: 'voice-1',
      onClientSend: frame => deferred.push(frame),
    })
    const stops = () => deferred.filter(frame => frame.type === 'conversation.stop')
    return { ws, adapter, stops }
  }

  async function armPendingSleepStop() {
    const ctx = setupPendingSleep()
    await sendVoiceClientMessage(ctx.ws as any, ctx.adapter, { type: 'sleep', text: '再见' })
    const input = ctx.ws.sent.map((d: string) => JSON.parse(d)).find((m: any) => m.type === 'text.input')!
    ctx.adapter.ingest({
      type: 'text.accepted', session_id: 'voice-1', request_id: input.request_id, turn_id: 'A1',
    })
    return ctx
  }

  test('an armed pending sleep still sends its deferred stop without interruption', async () => {
    const { adapter, stops } = await armPendingSleepStop()
    adapter.observeAvatarTurn('A1')
    adapter.observeAvatarTurn('B2')
    expect(stops()).toEqual([
      { type: 'conversation.stop', session_id: 'voice-1' },
    ])
  })

  test('an input with blank text still retires the pending sleep sequence', async () => {
    const { ws, adapter, stops } = await armPendingSleepStop()
    await sendVoiceClientMessage(ws as any, adapter, { type: 'input', text: '   ' })
    adapter.observeAvatarTurn('A1')
    adapter.observeAvatarTurn('B2')
    expect(stops()).toEqual([])
  })

  test('an input without text still retires the pending sleep sequence', async () => {
    const { ws, adapter, stops } = await armPendingSleepStop()
    await sendVoiceClientMessage(ws as any, adapter, { type: 'input' })
    adapter.observeAvatarTurn('A1')
    adapter.observeAvatarTurn('B2')
    expect(stops()).toEqual([])
  })

  test('a rejected bot_text input still retires the pending sleep sequence', async () => {
    const { ws, adapter, stops } = await armPendingSleepStop()
    await expect(sendVoiceClientMessage(ws as any, adapter, {
      type: 'input', text: 'hello', bot_text: 'verbatim',
    })).rejects.toThrow(/bot_text/)
    adapter.observeAvatarTurn('A1')
    adapter.observeAvatarTurn('B2')
    expect(stops()).toEqual([])
  })

  test('asr_session start maps to conversation.start', async () => {
    const { ws, adapter } = setup()
    await sendVoiceClientMessage(ws as any, adapter, { type: 'asr_session', command: 'start' })
    expect(ws.sent.map((d: string) => JSON.parse(d))).toEqual([
      { type: 'conversation.start', session_id: 'voice-1' },
    ])
  })

  test('asr_session stop maps to conversation.stop', async () => {
    const { ws, adapter } = setup()
    await sendVoiceClientMessage(ws as any, adapter, { type: 'asr_session', command: 'stop' })
    expect(ws.sent.map((d: string) => JSON.parse(d))).toEqual([
      { type: 'conversation.stop', session_id: 'voice-1' },
    ])
  })

  test('asr_session with should_respond true maps to conversation lifecycle', async () => {
    const { ws, adapter } = setup()
    await sendVoiceClientMessage(ws as any, adapter, {
      type: 'asr_session', command: 'start', should_respond: true,
    })
    expect(ws.sent.map((d: string) => JSON.parse(d))).toEqual([
      { type: 'conversation.start', session_id: 'voice-1' },
    ])
  })

  test('asr_session with should_respond false is rejected instead of silently dropped', async () => {
    const { ws, adapter } = setup()
    await expect(sendVoiceClientMessage(ws as any, adapter, {
      type: 'asr_session', command: 'start', should_respond: false,
    })).rejects.toThrow(/should_respond/)
    expect(ws.sent).toEqual([])
  })

  test('asr_session with an unknown command is rejected', async () => {
    const { ws, adapter } = setup()
    await expect(sendVoiceClientMessage(ws as any, adapter, {
      type: 'asr_session', command: 'nonsense' as any,
    })).rejects.toThrow(/asr_session/)
    expect(ws.sent).toEqual([])
  })

  test('config and ping frames are ignored', async () => {
    const { ws, adapter } = setup()
    await sendVoiceClientMessage(ws as any, adapter, { type: 'config' } as any)
    await sendVoiceClientMessage(ws as any, adapter, { type: 'ping', timestamp: 'now' } as any)
    expect(ws.sent).toEqual([])
  })
})

describe('disconnectVoiceClient', () => {
})
