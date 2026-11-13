/** @jest-environment jsdom */
import { createConversationConnection } from './conversation'
import { PROTOCOL_VERSION } from './adapter'
import { LocalMediaState } from './localMediaState'
import { ABGR8888 } from './localMediaProtocol'
import { VoiceProtocolError } from './conversationProtocol'
import type { AvatarAttachment, AvatarMediaEvent, AvatarMediaHost } from './avatarMediaHost'
import type { Logger } from '../types'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
class Socket {
  readyState = 1
  onopen: ((event: any) => void) | null = null
  onmessage: ((event: any) => void) | null = null
  onclose: ((event: any) => void) | null = null
  onerror: ((event: any) => void) | null = null
  sent: any[] = []
  wire: (string | ArrayBuffer | ArrayBufferView | Blob)[] = []
  close = jest.fn(() => { this.readyState = 3 })
  waiters: { type: string, done: (value: any) => void }[] = []
  send(data: any) {
    if (typeof data !== 'string' && !ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer) && !(data instanceof Blob)) {
      throw new TypeError('WebSocket text/binary value required')
    }
    this.wire.push(data)
    const value = typeof data === 'string' ? JSON.parse(data) : data
    this.sent.push(value)
    for (const w of this.waiters.filter(w => w.type === value.type)) w.done(value)
    this.waiters = this.waiters.filter(w => w.type !== value.type)
  }
  next(type: string): Promise<any> {
    return new Promise(done => this.waiters.push({ type, done }))
  }
  message(value: any) { this.onmessage?.({ data: typeof value === 'string' ? value : JSON.stringify(value) }) }
}
class Host implements AvatarMediaHost {
  listener?: (event: AvatarMediaEvent) => void
  nextAttach = deferred<AvatarAttachment>()
  nextStop = deferred<Parameters<AvatarMediaHost['stop']>[0]>()
  pending = new Map<string, ReturnType<typeof deferred<void>>>()
  targets: AvatarAttachment[] = []
  stops: Parameters<AvatarMediaHost['stop']>[0][] = []
  disposal = deferred<void>()
  holdDisposal = false
  disposeCalls = 0
  attach(target: AvatarAttachment) {
    this.targets.push(target)
    const wait = deferred<void>()
    this.pending.set(target.generation, wait)
    this.nextAttach.resolve(target)
    this.nextAttach = deferred<AvatarAttachment>()
    return wait.promise
  }
  accept(target: AvatarAttachment) { this.pending.get(target.generation)!.resolve() }
  stop(request: Parameters<AvatarMediaHost['stop']>[0]) {
    this.stops.push(request)
    this.nextStop.resolve(request)
    this.nextStop = deferred<Parameters<AvatarMediaHost['stop']>[0]>()
    if (request.reason === 'detach') this.pending.get(request.generation)?.reject(new Error('detached'))
    return Promise.resolve()
  }
  subscribe(listener: (event: AvatarMediaEvent) => void) {
    this.listener = listener
    return () => { this.listener = undefined }
  }
  frame(target: AvatarAttachment, sequence: number, turnId?: string, audioActive = true) {
    this.listener?.({ type: 'frameApplied', generation: target.generation, sequence: BigInt(sequence), turnId, audioActive })
  }
  dispose() {
    this.disposeCalls++
    for (const wait of this.pending.values()) wait.reject(new Error('disposed'))
    return this.holdDisposal ? this.disposal.promise : Promise.resolve()
  }
}
const logger: Logger = { debug: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn(), push: () => logger }
function fixture(extra: Partial<Parameters<typeof createConversationConnection>[0]> = {}) {
  const ws = new Socket(), host = new Host()
  let id = 0
  const connection = createConversationConnection({ voice: { interaction_endpoint: 'ws://local:8300', sessionId: 'voice' },
    videoId: 'avatar', mediaHost: host, logger, socketFactory: () => ws as any,
    attachmentIdFactory: () => `attachment-${++id}`, ...extra })
  async function allocated() {
    const requested = host.nextAttach.promise
    ws.message({ type: 'dh_2d_session_ready', session_id: 'canonical' })
    return requested
  }
  async function connected() {
    const target = await allocated()
    const start = ws.next('session.start')
    host.accept(target)
    await start
    ws.message({ type: 'session.state', session_id: 'voice', state: 'connected', protocol_version: PROTOCOL_VERSION })
    await connection.ready
    return target
  }
  const output = (type: string) => ws.sent.filter(frame => frame.type === type)
  return { ws, host, connection, allocated, connected, output }
}

test('canonical attachment and native acceptance precede the unchanged session handshake', async () => {
  const f = fixture()
  const target = await f.allocated()
  expect(target.dh2dSessionId).toBe('canonical')
  expect(target.conversationSessionId).toBe('voice')
  expect(f.ws.sent).toEqual([])
  expect(f.connection.connected).toBe(false)
  const start = f.ws.next('session.start')
  f.host.accept(target)
  expect(await start).toMatchObject({ session_id: 'voice', protocol_version: PROTOCOL_VERSION })
  f.ws.message({ type: 'session.state', session_id: 'voice', state: 'connected', protocol_version: PROTOCOL_VERSION })
  await f.connection.ready
  expect(f.connection.connected).toBe(true)
  expect(f.connection.mediaStatus).toBe('loading') // no healthy frame yet
  await f.connection.close()
})

test('first healthy frame in acceptance callback is not lost before attach continuation', async () => {
  const f = fixture()
  const target = await f.allocated()
  const start = f.ws.next('session.start')
  f.host.accept(target)
  f.host.frame(target, 1, 'A0')
  await start
  f.ws.message({ type: 'session.state', session_id: 'voice', state: 'connected', protocol_version: PROTOCOL_VERSION })
  await f.connection.ready
  f.host.frame(target, 2, 'B1')
  expect(f.output('playback.ended').map(x => x.turn_id)).toEqual(['A0'])
  expect(f.connection.mediaStatus).toBe('ready')
  await f.connection.close()
})

test('normal completion uses applied A→B, never activity false or logical turn.end', async () => {
  const f = fixture(); const t = await f.connected()
  f.ws.message({ type: 'audio.output.start', session_id: 'voice', turn_id: 'A0' })
  f.host.frame(t, 1, 'A0')
  f.host.frame(t, 2, 'A0', false)
  f.ws.message({ type: 'turn.end', session_id: 'voice', turn_id: 'A0' })
  expect(f.output('playback.ended')).toEqual([])
  f.host.frame(t, 3, undefined, false)
  f.host.frame(t, 4, '??', false)
  expect(f.output('playback.ended')).toEqual([])
  f.host.frame(t, 5, 'B1', false)
  f.host.frame(t, 6, 'A0') // retired old frame cannot end B1
  f.host.frame(t, 7, 'B1')
  expect(f.output('playback.ended')).toEqual([{ type: 'playback.ended', session_id: 'voice', turn_id: 'A0' }])
  await f.connection.close()
})

test('avatar side-effect completion does not require routed logical turn.end', async () => {
  const f = fixture(); const t = await f.connected()
  f.host.frame(t, 1, 'A0')
  f.host.frame(t, 2, 'B1')
  expect(f.output('playback.ended').map(x => x.turn_id)).toEqual(['A0'])
  await f.connection.close()
})

test('repeated applied observations preserve accepted-text pending sleep sequencing', async () => {
  const f = fixture(); const t = await f.connected()
  f.host.frame(t, 1, 'A0')
  await f.connection.send({ type: 'sleep', text: '再见' })
  const request = f.output('text.input').slice(-1)[0]
  f.ws.message({ type: 'text.accepted', session_id: 'voice', turn_id: 'A0', request_id: request.request_id })
  f.host.frame(t, 2, 'A0')
  expect(f.output('conversation.stop')).toEqual([])
  f.host.frame(t, 3, 'B1')
  f.host.frame(t, 4, 'C2')
  expect(f.output('conversation.stop')).toEqual([{ type: 'conversation.stop', session_id: 'voice' }])
  await f.connection.close()
})

test('exceptional stop retires accepted unseen output without ending a different current turn', async () => {
  const f = fixture(); const t = await f.connected()
  f.host.frame(t, 1, 'A0')
  f.ws.message({ type: 'audio.output.start', session_id: 'voice', turn_id: 'B1' })
  const stopped = f.host.nextStop.promise
  f.ws.message({ type: 'playback.stop', session_id: 'voice', turn_id: 'B1' })
  f.ws.message({ type: 'playback.stop', session_id: 'voice', turn_id: 'B1' })
  await stopped
  expect(f.output('playback.ended').map(x => x.turn_id)).toEqual(['B1'])
  expect(f.host.stops.filter(x => x.turnId === 'B1')).toHaveLength(1)
  f.host.frame(t, 2, 'C2')
  expect(f.output('playback.ended').map(x => x.turn_id)).toEqual(['B1', 'A0'])
  await f.connection.close()
})

test('exceptional receipt does not add an asynchronous native-flush prerequisite', async () => {
  const f = fixture(); await f.connected()
  const flushed = deferred<void>()
  f.host.stop = request => { f.host.stops.push(request); return flushed.promise }
  f.ws.message({ type: 'audio.output.start', session_id: 'voice', turn_id: 'A0' })
  f.ws.message({ type: 'playback.stop', session_id: 'voice', turn_id: 'A0' })
  expect(f.output('playback.ended').map(x => x.turn_id)).toEqual(['A0'])
  let closed = false
  const closing = f.connection.close().then(() => { closed = true })
  await Promise.resolve()
  expect(closed).toBe(false)
  flushed.resolve()
  await closing
})

test('wrong-session and unknown stops cannot fabricate retirement', async () => {
  const f = fixture(); const t = await f.connected()
  f.host.frame(t, 1, 'A0')
  f.ws.message({ type: 'playback.stop', session_id: 'wrong', turn_id: 'A0' })
  f.ws.message({ type: 'playback.stop', session_id: 'voice', turn_id: 'Z9' })
  expect(f.output('playback.ended')).toEqual([])
  expect(f.host.stops).toEqual([])
  await f.connection.close()
})

test('media detach/failure and reattach preserve conversation, tool result and QR root', async () => {
  const result = deferred<any>()
  const container = document.createElement('div'); document.body.append(container)
  const f = fixture({ bindingContainer: container, voice: { interaction_endpoint: 'ws://local', sessionId: 'voice',
    wechatPluginEndpoint: 'http://plugin', frontendToolHandler: () => result.promise } })
  const t = await f.connected()
  f.ws.message({ type: 'tool.call', session_id: 'voice', turn_id: 'A0', call_id: 'call', name: 'binding', arguments: {} })
  const listener = f.host.listener!
  f.host.listener?.({ type: 'failed', generation: t.generation, error: new Error('GPU lost') })
  expect(f.connection.mediaStatus).toBe('failed')
  expect(f.connection.connected).toBe(true)
  expect(f.ws.close).not.toHaveBeenCalled()
  expect(container.querySelector('[data-binding-ui]')).not.toBeNull()
  await f.connection.detachMedia()
  const next = f.host.nextAttach.promise
  const attaching = f.connection.attachMedia()
  const replacement = await next
  f.host.accept(replacement)
  await attaching
  listener({ type: 'frameApplied', generation: t.generation, sequence: 1n, turnId: 'Z9', audioActive: true })
  expect(f.connection.mediaStatus).toBe('loading')
  f.host.frame(replacement, 1, 'B1')
  expect(f.connection.mediaStatus).toBe('ready')
  expect(f.output('session.start')).toHaveLength(1)
  const sent = f.ws.next('tool.result')
  result.resolve({ ok: true, result: { status: 'initiated' } })
  expect(await sent).toMatchObject({ session_id: 'voice', turn_id: 'A0', call_id: 'call', ok: true })
  await f.connection.close()
  expect(container.querySelector('[data-binding-ui]')).toBeNull()
  container.remove()
})

test('same-WebSocket state recovery preserves pending stop ownership', async () => {
  const f = fixture(); await f.connected()
  f.ws.message({ type: 'audio.output.start', session_id: 'voice', turn_id: 'A0' })
  f.ws.message({ type: 'session.state', session_id: 'voice', state: 'connected', protocol_version: PROTOCOL_VERSION })
  f.ws.message({ type: 'playback.stop', session_id: 'voice', turn_id: 'A0' })
  expect(f.output('playback.ended').map(x => x.turn_id)).toEqual(['A0'])
  await f.connection.close()
})

test('client commands prepare/start input with JSON controls and header→binary PCM order', async () => {
  let onPcm: (data: Uint8Array) => void = () => undefined
  const mic = { ready: Promise.resolve(), stop: jest.fn(async () => {}),
    setOnPcm: jest.fn((next: (data: Uint8Array) => void) => { onPcm = next }) }
  const create = jest.fn(() => mic)
  const f = fixture({ microphoneFactory: create }); await f.connected()
  expect(create).not.toHaveBeenCalled()
  const prepared = f.ws.next('audio.input.ready')
  f.ws.message({ type: 'audio.input.prepare', session_id: 'voice', state_epoch: 'epoch', source_revision: 1 })
  await prepared
  expect(create).toHaveBeenCalledTimes(1)
  f.ws.message({ type: 'capture.start', session_id: 'voice', state_epoch: 'epoch', source_revision: 1, turn_id: 'A0' })
  expect(f.output('capture.started').map(x => x.turn_id)).toEqual(['A0'])
  const pcm = new Uint8Array([0, 1, 2, 3])
  onPcm(pcm)
  const [header, payload] = f.ws.wire.slice(-2)
  expect(typeof header).toBe('string')
  expect(JSON.parse(header as string)).toMatchObject({ type: 'audio.input.delta', direction: 'input',
    session_id: 'voice', turn_id: 'A0', byte_count: pcm.byteLength })
  expect(payload).toEqual(pcm)
  await f.connection.detachMedia()
  expect(create).toHaveBeenCalledTimes(1)
  await f.connection.close()
  expect(mic.stop).toHaveBeenCalledTimes(1)
})

test('close during attach fences late callbacks and joins native retirement exactly once', async () => {
  const f = fixture(); const t = await f.allocated(); const listener = f.host.listener!
  f.host.holdDisposal = true
  let closed = false
  const closing = f.connection.close().then(() => { closed = true })
  listener({ type: 'frameApplied', generation: t.generation, sequence: 1n, turnId: 'A0', audioActive: true })
  await Promise.resolve()
  expect(closed).toBe(false)
  expect(f.ws.sent).toEqual([])
  f.host.disposal.resolve()
  await closing
  await f.connection.close()
  expect(f.host.disposeCalls).toBe(1)
  expect(f.ws.close).toHaveBeenCalledTimes(1)
  await expect(f.connection.ready).rejects.toThrow('connection aborted')
})

test('tool result settling after conversation close never reaches a replacement connection', async () => {
  const result = deferred<any>()
  const f = fixture({ voice: { interaction_endpoint: 'ws://local', sessionId: 'voice', frontendToolHandler: () => result.promise } })
  await f.connected()
  f.ws.message({ type: 'tool.call', session_id: 'voice', turn_id: 'A0', call_id: 'call', name: 'tool', arguments: {} })
  await f.connection.close()
  result.resolve({ ok: true, result: {} })
  await result.promise
  expect(f.output('tool.result')).toEqual([])
})

test('bad version is a terminal protocol error, not a hidden RTC fallback', async () => {
  const f = fixture(); const t = await f.allocated(); const start = f.ws.next('session.start')
  f.host.accept(t); await start
  f.ws.message({ type: 'session.state', session_id: 'voice', state: 'connected', protocol_version: -1 })
  await expect(f.connection.ready).rejects.toBeInstanceOf(VoiceProtocolError)
  await expect(f.connection.failure).rejects.toBeInstanceOf(VoiceProtocolError)
  await f.connection.close()
})

test('binary output remains a notification and config is not sent to the client', async () => {
  const f = fixture(); await f.connected()
  await f.connection.send({ type: 'config', llm_service: { provider: 'openai', token: 'fixture-only-not-a-secret' } })
  expect(f.ws.sent.some(x => x.type === 'config')).toBe(false)
  const heard: unknown[] = []
  f.connection.on('audio', x => heard.push(x))
  f.ws.onmessage?.({ data: new ArrayBuffer(4) })
  expect(heard).toHaveLength(1)
  expect(f.host.targets).toHaveLength(1)
  expect(f.host.stops).toEqual([])
  await f.connection.close()
})

test('initial media failure leaves conversation transport available for explicit attachment retry', async () => {
  const f = fixture(); const t = await f.allocated()
  const failed = new Promise<void>(resolve => f.connection.on('mediaStatus', status => { if (status === 'failed') resolve() }))
  f.host.pending.get(t.generation)!.reject(new Error('local media unavailable'))
  await failed
  expect(f.ws.sent).toEqual([])
  expect(f.ws.close).not.toHaveBeenCalled()
  expect(f.connection.connected).toBe(false)
  const requested = f.host.nextAttach.promise
  const retried = f.connection.attachMedia()
  const next = await requested
  const start = f.ws.next('session.start')
  f.host.accept(next)
  await retried
  await start
  f.ws.message({ type: 'session.state', session_id: 'voice', state: 'connected', protocol_version: PROTOCOL_VERSION })
  await f.connection.ready
  expect(f.connection.connected).toBe(true)
  await f.connection.close()
})

test('missing applied-frame observation fails media without inventing a turn boundary', async () => {
  const f = fixture(); const t = await f.connected()
  f.host.frame(t, 1, 'A0')
  f.host.frame(t, 3, 'B1')
  f.host.frame(t, 4, 'C2')
  expect(f.connection.mediaStatus).toBe('failed')
  expect(f.connection.connected).toBe(true)
  expect(f.output('playback.ended')).toEqual([])
  expect(f.ws.close).not.toHaveBeenCalled()
  await f.connection.close()
})

test('the portable conversation can connect when RTC is unavailable', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'RTCPeerConnection')
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true,
    get() { throw new Error('RTC must not be used by conversation') } })
  try {
    const f = fixture(); const t = await f.connected()
    f.host.frame(t, 1, 'A0')
    f.host.frame(t, 2, 'B1')
    expect(f.output('playback.ended').map(x => x.turn_id)).toEqual(['A0'])
    await f.connection.close()
  } finally {
    if (previous) Object.defineProperty(globalThis, 'RTCPeerConnection', previous)
    else delete (globalThis as any).RTCPeerConnection
  }
})

test('native retirement failure is reported while other connection resources still close', async () => {
  const f = fixture(); await f.connected()
  const dispose = jest.fn(() => { throw new Error('native retirement failed') })
  f.host.dispose = dispose
  await expect(f.connection.close()).rejects.toThrow('native retirement failed')
  await expect(f.connection.close()).rejects.toThrow('native retirement failed')
  expect(dispose).toHaveBeenCalledTimes(1)
  expect(f.ws.close).toHaveBeenCalledTimes(1)
})

test('detach retirement finishes before a replacement native owner is admitted', async () => {
  const f = fixture(); await f.connected()
  const stopped = deferred<void>()
  f.host.stop = request => { f.host.stops.push(request); return stopped.promise }
  let retired = false
  const admittedAfterRetirement: boolean[] = []
  const attach = f.host.attach.bind(f.host)
  f.host.attach = target => {
    admittedAfterRetirement.push(retired)
    const accepted = attach(target)
    f.host.accept(target)
    return accepted
  }
  const detaching = f.connection.detachMedia()
  const attaching = f.connection.attachMedia()
  await Promise.resolve() // concurrent work may run; native stop is still pending
  retired = true
  stopped.resolve()
  await Promise.all([detaching, attaching])
  expect(admittedAfterRetirement).toEqual([true])
  expect(f.connection.connected).toBe(true)
  expect(f.ws.close).not.toHaveBeenCalled()
  await f.connection.close()
})

test('detach cancels an attach queued behind native retirement before that attach can start', async () => {
  const f = fixture(); await f.connected()
  const stopped = deferred<void>()
  f.host.stop = request => { f.host.stops.push(request); return stopped.promise }
  const firstDetach = f.connection.detachMedia()
  const queuedAttach = f.connection.attachMedia()
  const cancellingDetach = f.connection.detachMedia()
  stopped.resolve()
  await Promise.all([firstDetach, queuedAttach, cancellingDetach])
  expect(f.host.targets).toHaveLength(1) // only the original, now retired owner
  expect(f.connection.connected).toBe(true)
  await f.connection.close()
})

test('pending attachment is cancelled immediately rather than placing detach behind its acceptance', async () => {
  const f = fixture(); const t = await f.allocated()
  await f.connection.detachMedia()
  expect(f.host.stops.some(x => x.generation === t.generation && x.reason === 'detach')).toBe(true)
  expect(f.output('session.start')).toEqual([])
  expect(f.ws.close).not.toHaveBeenCalled()
  await f.connection.close()
})

test('failed retirement blocks replacement instead of silently creating another native owner', async () => {
  const f = fixture(); await f.connected()
  f.host.stop = async () => { throw new Error('native owner not retired') }
  await expect(f.connection.detachMedia()).rejects.toThrow('native owner not retired')
  await expect(f.connection.attachMedia()).rejects.toThrow('native owner not retired')
  expect(f.host.targets).toHaveLength(1)
  expect(f.connection.connected).toBe(true)
  await expect(f.connection.close()).rejects.toThrow('native owner not retired')
})

test('untargeted explicit stop retires only the observed current turn, not accepted unseen output', async () => {
  const f = fixture(); const t = await f.connected()
  f.host.frame(t, 1, 'A0')
  f.ws.message({ type: 'audio.output.start', session_id: 'voice', turn_id: 'B1' })
  f.ws.message({ type: 'playback.stop', session_id: 'voice' })
  f.ws.message({ type: 'playback.stop', session_id: 'voice' })
  expect(f.output('playback.ended').map(x => x.turn_id)).toEqual(['A0'])
  expect(f.host.stops.map(x => x.turnId)).toEqual(['A0'])
  f.host.frame(t, 2, 'B1')
  f.host.frame(t, 3, 'C2')
  expect(f.output('playback.ended').map(x => x.turn_id)).toEqual(['A0', 'B1'])
  await f.connection.close()
})

test('replacement requested synchronously by loading waits behind detach retirement', async () => {
  const f = fixture(); const t = await f.connected()
  f.host.frame(t, 1, 'A0') // loading notification on detach is a real change
  const stopped = deferred<void>()
  f.host.stop = request => { f.host.stops.push(request); return stopped.promise }
  let retired = false
  const admittedAfterRetirement: boolean[] = []
  const attach = f.host.attach.bind(f.host)
  f.host.attach = target => {
    admittedAfterRetirement.push(retired)
    const accepted = attach(target)
    f.host.accept(target)
    return accepted
  }
  let replacement: Promise<void> | undefined
  f.connection.on('mediaStatus', status => {
    if (status === 'loading') replacement = f.connection.attachMedia()
  })
  const detaching = f.connection.detachMedia()
  expect(replacement).toBeDefined()
  await Promise.resolve()
  retired = true
  stopped.resolve()
  await Promise.all([detaching, replacement])
  expect(admittedAfterRetirement).toEqual([true])
  expect(f.connection.connected).toBe(true)
  await f.connection.close()
})

test('reentrant retry cannot send session.start using a never-attached provisional target', async () => {
  const f = fixture(); const first = await f.allocated()
  const failed = new Promise<void>(resolve => f.connection.on('mediaStatus', status => { if (status === 'failed') resolve() }))
  f.host.pending.get(first.generation)!.reject(new Error('initial attach failed'))
  await failed
  let duplicate: Promise<void> | undefined
  f.connection.on('mediaStatus', status => {
    if (status === 'loading') duplicate = f.connection.attachMedia()
  })
  const requested = f.host.nextAttach.promise
  const start = f.ws.next('session.start')
  const retry = f.connection.attachMedia()
  const firstEffect = await Promise.race([
    requested.then(target => ({ type: 'attachment' as const, target })),
    start.then(() => ({ type: 'handshake' as const })),
  ])
  expect(firstEffect.type).toBe('attachment')
  if (firstEffect.type !== 'attachment') throw new Error('session.start preceded actual native attachment')
  expect(f.output('session.start')).toEqual([])
  f.host.accept(firstEffect.target)
  await Promise.all([retry, duplicate])
  await start
  f.ws.message({ type: 'session.state', session_id: 'voice', state: 'connected', protocol_version: PROTOCOL_VERSION })
  await f.connection.ready
  expect(f.connection.connected).toBe(true)
  expect(f.output('session.start')).toHaveLength(1)
  await f.connection.close()
})

test('stop(A) cannot retire B applied synchronously during native stop dispatch', async () => {
  const f = fixture(); const t = await f.connected()
  f.ws.message({ type: 'audio.output.start', session_id: 'voice', turn_id: 'A0' })
  f.host.frame(t, 1, 'A0')
  f.host.stop = request => {
    f.host.stops.push(request)
    f.host.frame(t, 2, 'B1')
    return Promise.resolve()
  }
  f.ws.message({ type: 'playback.stop', session_id: 'voice', turn_id: 'A0' })
  expect(f.output('playback.ended').map(x => x.turn_id)).toEqual(['A0'])
  f.host.frame(t, 3, 'C2')
  expect(f.output('playback.ended').map(x => x.turn_id)).toEqual(['A0', 'B1'])
  await f.connection.close()
})

test('later status subscribers cannot receive stale ready after reentrant detach delivered loading', async () => {
  const f = fixture(); const t = await f.connected()
  let detaching: Promise<void> | undefined
  f.connection.on('mediaStatus', status => { if (status === 'ready') detaching = f.connection.detachMedia() })
  const seen: string[] = []
  f.connection.on('mediaStatus', status => seen.push(status))
  f.host.frame(t, 1, 'A0')
  await detaching
  expect(seen[seen.length - 1]).toBe('loading')
  expect(seen).not.toContain('ready')
  expect(f.connection.mediaStatus).toBe('loading')
  expect(f.connection.connected).toBe(true)
  await f.connection.close()
})

test('close during ready notification fences remaining subscribers and later readiness replay', async () => {
  const f = fixture(); const t = await f.connected()
  let closing: Promise<void> | undefined
  f.connection.on('mediaStatus', status => { if (status === 'ready') closing = f.connection.close() })
  const seen: string[] = []
  f.connection.on('mediaStatus', status => seen.push(status))
  f.host.frame(t, 1, 'A0')
  await closing
  expect(seen).not.toContain('ready')
  expect(f.connection.connected).toBe(false)
  const late: string[] = []
  f.connection.on('mediaStatus', status => late.push(status))
  expect(late).toEqual([])
})

test('media status retains live replay, deduplication and on/off unsubscription', async () => {
  const f = fixture(); const t = await f.connected()
  const first: string[] = []
  const unsubscribe = f.connection.on('mediaStatus', status => first.push(status))
  expect(first).toEqual(['loading'])
  f.host.frame(t, 1, 'A0'); f.host.frame(t, 2, 'A0')
  expect(first).toEqual(['loading', 'ready'])
  unsubscribe()
  f.host.listener?.({ type: 'failed', generation: t.generation, error: new Error('native lost') })
  expect(first).toEqual(['loading', 'ready'])
  const second: string[] = [], named = (status: string) => second.push(status)
  f.connection.on('mediaStatus', named)
  expect(second).toEqual(['failed'])
  f.connection.off('mediaStatus', named)
  await f.connection.detachMedia()
  expect(second).toEqual(['failed'])
  const third: string[] = []
  f.connection.on('mediaStatus', status => third.push(status))
  expect(third).toEqual(['loading'])
  f.connection.off('mediaStatus')
  const requested = f.host.nextAttach.promise, attaching = f.connection.attachMedia()
  const next = await requested
  f.host.accept(next); await attaching
  f.host.frame(next, 1, 'B1')
  expect(third).toEqual(['loading'])
  await f.connection.close()
})

test('readiness subscriber detaching the view cannot discard an already-applied A→B boundary', async () => {
  const f = fixture(); const first = await f.connected()
  f.host.frame(first, 1, 'A0')
  await f.connection.detachMedia()
  const requested = f.host.nextAttach.promise, attaching = f.connection.attachMedia()
  const next = await requested
  f.host.accept(next); await attaching
  let detaching: Promise<void> | undefined
  f.connection.on('mediaStatus', status => { if (status === 'ready') detaching = f.connection.detachMedia() })
  f.host.frame(next, 1, 'B1')
  await detaching
  expect(f.output('playback.ended').map(x => x.turn_id)).toEqual(['A0'])
  expect(f.connection.connected).toBe(true)
  await f.connection.close()
})

test('wire STATE and resolved FRAME are not playback; healthy applied A→B alone emits the receipt', async () => {
  const f = fixture(); const t = await f.connected()
  const target = { sessionId: t.dh2dSessionId, generation: t.generation, attachment: t.attachment }
  const wire = new LocalMediaState(target)
  wire.accept({ kind: 'layout', target, allocation: 1n, width: 3, height: 2, fourcc: ABGR8888,
    stride: 16n, offset: 0n, modifier: 0n, extent: 32n, rowOrigin: 1, colorSpace: 1,
    sampleRate: 22050, channels: 1, sampleFormat: 1 })
  wire.accept({ kind: 'attached', target, allocation: 1n })
  wire.accept({ kind: 'state', target, effectiveFrame: 1n, snapshot: true, turnId: 'A0', audioActive: true })
  const a = wire.accept({ kind: 'frame', target, sequence: 1n, allocation: 1n, rendererFrame: 19n,
    producedNs: 1n, sampleStart: 0n, sampleCount: 1n, pcm: Uint8Array.of(0, 0) })!
  f.host.frame(t, 1, a.state.turnId ?? undefined, a.state.audioActive)
  wire.accept({ kind: 'state', target, effectiveFrame: 2n, snapshot: false, turnId: 'B1', audioActive: false })
  expect(f.output('playback.ended')).toEqual([])
  const b = wire.accept({ kind: 'frame', target, sequence: 2n, allocation: 1n, rendererFrame: 20n,
    producedNs: 2n, sampleStart: 1n, sampleCount: 1n, pcm: Uint8Array.of(0, 0) })!
  expect(f.output('playback.ended')).toEqual([])
  // Fake media owner signals only after its playback/submission gate, not RX.
  f.host.frame(t, 2, b.state.turnId ?? undefined, b.state.audioActive)
  expect(f.output('playback.ended').map(x => x.turn_id)).toEqual(['A0'])
  await f.connection.close()
})
