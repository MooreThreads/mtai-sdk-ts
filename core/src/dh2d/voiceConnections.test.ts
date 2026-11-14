/** @jest-environment jsdom */
import { abortable } from '../abortable'
import { hooks } from '../hooks'
import { connectVoiceClient } from './voiceConnections'
import { PROTOCOL_VERSION } from '../voice/adapter'
import type { AvatarBridge } from '../voice/avatarBridge'
import type { AvatarAttachment } from '../voice/avatarMediaHost'
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
class Socket {
  static instances: Socket[] = []; sent: any[] = []; readyState = 1; closed = false
  onmessage: any; onclose: any; onerror: any; onopen: any
  constructor(readonly url: string) { Socket.instances.push(this) }
  send(value: string) { this.sent.push(JSON.parse(value)) }
  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
  close() { this.closed = true; this.onclose?.() }
}
function fixture() {
  const scope = abortable(); let accept!: () => void, finishStop!: () => void
  const targets: AvatarAttachment[] = [], retirement = new Promise<void>(resolve => { finishStop = resolve })
  const bridge: AvatarBridge = { attach: target => { targets.push(target); return new Promise<void>(resolve => { accept = resolve }) },
    stop: jest.fn(() => retirement), subscribe: () => () => {}, dispose: async () => {}, mount: () => {}, unmount: () => {} }
  ;(globalThis as any).mtaiAvatar = bridge
  const config = hooks.dh2d.defaultConfig({ videoId: 'avatar', voiceClient: { interaction_endpoint: 'ws://localhost:8780/base?keep=1' } })
  const connecting = connectVoiceClient(hooks.logger, { container: document.body }, config, scope)
  void connecting.catch(() => {})
  return { scope, connecting, targets, accept: () => accept(), finishStop }
}
beforeEach(() => { jest.useFakeTimers(); Socket.instances = []; (globalThis as any).WebSocket = Socket
 Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: require('node:crypto').randomUUID }) })
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); delete (globalThis as any).mtaiAvatar })
test('default main identity and canonical attachment precede exact version acknowledgement without RTC', async () => {
  const f = fixture(); const ws = Socket.instances[0]
  expect(new URL(ws.url).pathname).toBe('/base/avatar-channel-session')
  ws.message({ type: 'dh_2d_session_ready', session_id: 'canonical' }); await flush(); expect(f.targets[0].dh2dSessionId).toBe('canonical'); expect(ws.sent).toEqual([])
  f.accept(); await flush(); expect(ws.sent[0].protocol_version).toBe(PROTOCOL_VERSION)
  let connected = false; void f.connecting.then(() => { connected = true }); await flush(); expect(connected).toBe(false)
  ws.message({ type: 'session.state', state: 'connected', session_id: 'avatar-channel-session', protocol_version: PROTOCOL_VERSION })
  const connection = await f.connecting; expect(connection.connected).toBe(true); f.finishStop(); await connection.close()
})
test('existing connect timeout cancels but joins local retirement before the unchanged retry delay', async () => {
  const f = fixture(); const ws = Socket.instances[0]
  ws.message({ type: 'dh_2d_session_ready', session_id: 'canonical' }); await flush()
  await jest.advanceTimersByTimeAsync(60000); expect(ws.closed).toBe(true); expect(Socket.instances).toHaveLength(1)
  await jest.advanceTimersByTimeAsync(2000); expect(Socket.instances).toHaveLength(1)
  f.finishStop(); f.accept(); await flush(); await jest.advanceTimersByTimeAsync(2000); expect(Socket.instances).toHaveLength(2)
  f.scope.abort(); await expect(f.connecting).rejects.toThrow()
})
test('protocol mismatch is terminal and closes ownership without a compatibility retry', async () => {
  const f = fixture(); const ws = Socket.instances[0]; ws.message({ type: 'dh_2d_session_ready', session_id: 'canonical' }); await flush(); f.accept(); await flush()
  ws.message({ type: 'session.state', state: 'connected', session_id: 'avatar-channel-session', protocol_version: 999 }); f.finishStop()
  await expect(f.connecting).rejects.toThrow('protocol'); await jest.advanceTimersByTimeAsync(2000); expect(Socket.instances).toHaveLength(1)
})
test('pre-aborted entry creates neither socket nor media ownership', async () => {
  const scope = abortable(); scope.abort()
  await expect(connectVoiceClient(hooks.logger, {}, hooks.dh2d.defaultConfig(), scope)).rejects.toThrow('connection aborted')
  expect(Socket.instances).toHaveLength(0)
})
