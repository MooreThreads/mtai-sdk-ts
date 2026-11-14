/** @jest-environment jsdom */
import { createDH2DSession } from './sessions'
import { hooks } from '../hooks'
import { PROTOCOL_VERSION } from '../voice/adapter'
import type { AvatarBridge } from '../voice/avatarBridge'
import type { AvatarAttachment, AvatarMediaEvent } from '../voice/avatarMediaHost'

class Socket {
  static instances: Socket[] = []
  readyState = 1; sent: any[] = []; onmessage: any; onclose: any; onerror: any; onopen: any
  constructor() { Socket.instances.push(this) }
  send(value: string) { this.sent.push(JSON.parse(value)) }
  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
  close() { this.readyState = 3; this.onclose?.() }
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
function fixture() {
  const listeners = new Set<(event: AvatarMediaEvent) => void>()
  const targets: AvatarAttachment[] = [], accept: (() => void)[] = []
  const bridge: AvatarBridge = {
    attach: jest.fn(target => { targets.push(target); return new Promise<void>(resolve => accept.push(resolve)) }),
    stop: jest.fn(async () => {}), dispose: jest.fn(async () => {}), mount: jest.fn(), unmount: jest.fn(),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  ;(globalThis as any).mtaiAvatar = bridge
  const parent = document.createElement('div'); document.body.appendChild(parent)
  const session = createDH2DSession(parent, { videoId: 'avatar', audioInput: false })
  const frame = (sequence: bigint, turnId = 'A0') => { for (const listener of listeners) listener({ type: 'frameApplied', generation: targets[targets.length - 1].generation, sequence, turnId, audioActive: true }) }
  async function connected() {
    await flush(); const ws = Socket.instances[Socket.instances.length - 1]
    ws.message({ type: 'dh_2d_session_ready', session_id: 'canonical' }); await flush()
    expect(ws.sent).toEqual([]); accept.shift()!(); await flush()
    expect(ws.sent[0].type).toBe('session.start')
    ws.message({ type: 'session.state', session_id: 'avatar-channel-session', protocol_version: PROTOCOL_VERSION, state: 'connected' }); await flush()
    return ws
  }
  return { session, parent, bridge, connected, frame, targets, accept, listeners }
}
let before: typeof hooks.dh2d.beforeConnectingSession
beforeEach(() => {
  Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: require('node:crypto').randomUUID })
  jest.useFakeTimers(); Socket.instances = []
  ;(globalThis as any).WebSocket = Socket
  before = hooks.dh2d.beforeConnectingSession; hooks.dh2d.beforeConnectingSession = async () => {}
})
afterEach(() => { hooks.dh2d.beforeConnectingSession = before; delete (globalThis as any).mtaiAvatar; jest.clearAllTimers(); jest.useRealTimers(); document.body.innerHTML = '' })

test('public facade waits actual attachment, independently exposes conversation/media status, and has no login dependency', async () => {
  const f = fixture(), statuses: string[] = [], media: string[] = []
  f.session.on('statuschange', value => statuses.push(value)); f.session.on('mediaStatus', value => media.push(value))
  await f.connected(); expect(f.session.sessionId).toBe('canonical'); expect(f.session.status).toBe('connected'); expect(f.session.mediaStatus).toBe('loading')
  f.frame(1n); expect(f.session.mediaStatus).toBe('ready'); expect(statuses).toEqual(['connected']); expect(media).toEqual(['loading', 'ready'])
  await f.session.close(); expect(f.bridge.stop).toHaveBeenCalledWith(expect.objectContaining({ reason: 'detach' })); expect(f.bridge.dispose).not.toHaveBeenCalled()
})
test('view remount preserves conversation, QR hierarchy, native audio owner and control traffic', async () => {
  const f = fixture(); const ws = await f.connected(); f.frame(1n)
  const qrContainer = f.parent.querySelector('#mt_dh2d_container')!
  f.session.mountAvatar('#one'); f.session.unmountAvatar(); f.session.mountAvatar('#two')
  expect(f.parent.querySelector('#mt_dh2d_container')).toBe(qrContainer); expect(f.bridge.attach).toHaveBeenCalledTimes(1)
  await f.session.send({ type: 'wakeup', text: 'hello' }); expect(ws.sent.some(message => message.type === 'conversation.start')).toBe(true)
  expect(ws.readyState).toBe(1); await f.session.close()
})
test('media failure retains conversation and explicit attachment retry uses a fresh identity', async () => {
  const f = fixture(); const ws = await f.connected(); const original = f.targets[0]
  for (const listener of f.listeners) listener({ type: 'failed', generation: original.generation, error: Error('graphics failed') })
  expect(f.session.mediaStatus).toBe('failed'); expect(f.session.status).toBe('connected'); expect(ws.readyState).toBe(1)
  const attaching = f.session.attachMedia(); await flush(); expect(f.targets[1].generation).not.toBe(original.generation); f.accept.shift()!(); await attaching
  expect(ws.sent.filter(message => message.type === 'session.start')).toHaveLength(1); await f.session.close()
})
test('empty explicit stop falls back to the observed turn exactly once and normal A->B remains applied-frame driven', async () => {
  const f = fixture(); const ws = await f.connected(); f.frame(1n)
  ws.message({ type: 'playback.stop', turn_id: '', session_id: 'avatar-channel-session' }); ws.message({ type: 'playback.stop', turn_id: '' })
  expect(ws.sent.filter(message => message.type === 'playback.ended').map(message => message.turn_id)).toEqual(['A0'])
  expect(f.bridge.stop).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'A0', reason: 'interrupt' }))
  f.frame(2n, 'B1'); f.frame(3n, 'C2')
  expect(ws.sent.filter(message => message.type === 'playback.ended').map(message => message.turn_id)).toEqual(['A0', 'B1']); await f.session.close()
})
test('initial media failure and the existing timeout/retry preserve the session-owned QR root', async () => {
  const f = fixture();await flush();const first=Socket.instances[0]
  first.message({type:'dh_2d_session_ready',session_id:'canonical'});await flush()
  const qr=f.parent.querySelector('#mt_dh2d_container')!.firstElementChild
  expect(qr).not.toBeNull()
  for(const listener of f.listeners)listener({type:'failed',generation:f.targets[0].generation,error:Error('graphics failed')})
  expect(f.session.mediaStatus).toBe('failed')
  await jest.advanceTimersByTimeAsync(60000);f.accept.shift()!();await flush();await jest.advanceTimersByTimeAsync(2000);await flush()
  expect(Socket.instances).toHaveLength(2);expect(f.parent.querySelector('#mt_dh2d_container')!.firstElementChild).toBe(qr)
  const next=Socket.instances[1];next.message({type:'dh_2d_session_ready',session_id:'replacement'});await flush();f.accept.shift()!();await flush()
  next.message({type:'session.state',session_id:'avatar-channel-session',protocol_version:PROTOCOL_VERSION,state:'connected'});await flush()
  expect(f.session.status).toBe('connected');expect(f.parent.querySelector('#mt_dh2d_container')!.firstElementChild).toBe(qr)
  await f.session.close();expect(f.parent.querySelector('#mt_dh2d_container')).toBeNull()
})

test('terminal protocol rejection fences future sends rather than buffering undeliverable commands', async () => {
 const f=fixture();await flush();const ws=Socket.instances[0]
 ws.message({type:'unexpected-setup'});await flush();expect(f.session.status).toBe('failed')
 await expect(f.session.send({type:'wakeup',text:'must not queue'})).rejects.toThrow('session is closed');await f.session.close()
})

test.each(['socket loss', 'scheduled reconnect'])('%s buffers commands while retirement is pending and delivers once on replacement', async reason => {
  const f = fixture(); const first = await f.connected()
  let release!: () => void
  const retiring = new Promise<void>(resolve => { release = resolve })
  ;(f.bridge.stop as jest.Mock).mockImplementationOnce(() => retiring)
  if (reason === 'socket loss') { first.close(); await flush() }
  else await jest.advanceTimersByTimeAsync(20 * 60 * 1000)
  expect(f.session.status).toBe('reconnecting')
  expect(Socket.instances).toHaveLength(1)
  await expect(f.session.send({ type: 'input', text: 'queued during retirement' })).resolves.toBeUndefined()
  expect(first.sent.filter(message => message.type === 'text.input')).toEqual([])
  release(); await flush()
  expect(Socket.instances).toHaveLength(2)
  const replacement = await f.connected()
  expect(replacement.sent.filter(message => message.type === 'text.input').map(message => message.text)).toEqual(['queued during retirement'])
  expect(first.sent.filter(message => message.type === 'text.input')).toEqual([])
  await f.session.close()
})

test('scheduled idle reconnect retains its existing interval and rejects callbacks from the retired attempt', async () => {
  const f = fixture(); const ws = await f.connected(); const stale = ws.onmessage
  await jest.advanceTimersByTimeAsync(20 * 60 * 1000); await flush()
  expect(f.session.status).toBe('reconnecting'); expect(Socket.instances).toHaveLength(2); expect(ws.readyState).toBe(3)
  const messages: unknown[] = []; f.session.on('message', value => messages.push(value)); stale({ data: JSON.stringify({ type: 'asr.final', text: 'stale' }) }); expect(messages).toEqual([])
  await f.session.close()
})
