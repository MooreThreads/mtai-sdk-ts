import { createVoiceInputControl } from './inputControl'

test('prepare owns resources before capture; ack precedes PCM; stop gates without reopening', async () => {
  const sent: any[] = []
  let pcm!: (data: Uint8Array) => void
  const stop = jest.fn()
  const create = jest.fn((onPcm: typeof pcm) => { pcm = onPcm; return { ready: Promise.resolve(), stop, setOnPcm(onPcm: typeof pcm) { pcm = onPcm } } })
  const control = createVoiceInputControl({ sessionId: 's', create, send: frame => sent.push(frame) })
  const id = { session_id: 's', state_epoch: 'e', source_revision: 1 }
  control.ingest({ type: 'audio.input.prepare', ...id })
  await Promise.resolve()
  expect(sent[0]).toEqual({ type: 'audio.input.ready', ...id })
  pcm(new Uint8Array([1, 2]))
  expect(sent).toHaveLength(1)
  control.ingest({ type: 'capture.start', ...id, turn_id: 'A' })
  pcm(new Uint8Array([1, 2]))
  expect(sent.slice(1).map(f => f.type ?? 'binary')).toEqual(['capture.started', 'audio.input.delta', 'binary'])
  const oldPcm = pcm
  control.ingest({ type: 'capture.stop', ...id, turn_id: 'A' })
  pcm(new Uint8Array([3, 4]))
  expect(sent[sent.length - 1].type).toBe('capture.stopped')
  expect(stop).not.toHaveBeenCalled()
  control.ingest({ type: 'capture.start', ...id, turn_id: 'B' })
  expect(create).toHaveBeenCalledTimes(1)
  const count = sent.length
  oldPcm(new Uint8Array([5, 6]))
  control.ingest({ type: 'capture.start', ...id, turn_id: 'A' })
  expect(sent).toHaveLength(count)
  pcm(new Uint8Array([7, 8]))
  expect(sent[sent.length - 2].turn_id).toBe('B')
  control.ingest({ type: 'audio.input.release', ...id })
  expect(stop).toHaveBeenCalledTimes(1)
})

test('late prepare completion cannot resurrect resources and errors are sanitized', async () => {
  const sent: any[] = []
  let ready!: () => void
  const stop = jest.fn()
  const control = createVoiceInputControl({ sessionId: 's',
    create: () => ({ ready: new Promise<void>(resolve => { ready = resolve }), stop, setOnPcm() {} }),
    send: frame => sent.push(frame) })
  const id = { session_id: 's', state_epoch: 'e', source_revision: 2 }
  control.ingest({ type: 'audio.input.prepare', ...id })
  control.ingest({ type: 'audio.input.release', ...id })
  expect(sent).toEqual([]) // no release receipt while acquisition is pending
  ready()
  for (let i = 0; i < 8; i++) await Promise.resolve()
  expect(sent.map(f => f.type)).toEqual(['audio.input.released'])
  expect(stop).toHaveBeenCalledTimes(1)
})

test('post-ready source loss retires capture, reports sanitized error, fences late PCM', async () => {
  const sent: any[] = []
  let lost!: () => void
  let pcm!: (data: Uint8Array) => void
  const stop = jest.fn()
  const control = createVoiceInputControl({ sessionId: 's', send: event => sent.push(event),
    create: (_, onLost) => {
      lost = onLost
      return { ready: Promise.resolve(), stop, setOnPcm(callback) { pcm = callback } }
    } })
  const id = { session_id: 's', state_epoch: 'e', source_revision: 1 }
  control.ingest({ type: 'audio.input.prepare', ...id })
  await Promise.resolve()
  control.ingest({ type: 'capture.start', ...id, turn_id: 'A' })
  const oldPcm = pcm
  lost()
  expect(sent[sent.length - 1]).toEqual({ type: 'audio.input.error', ...id, code: 'device_lost' })
  const count = sent.length
  oldPcm(new Uint8Array([1, 2]))
  expect(sent).toHaveLength(count)
  expect(stop).toHaveBeenCalledTimes(1)
})
