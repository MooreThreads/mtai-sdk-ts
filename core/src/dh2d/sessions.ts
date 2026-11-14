import { abortable, withChild } from '../abortable'
import { events } from '../events'
import { hooks } from '../hooks'
import type { DHInputMessage, DHOutputMessage } from '../types'
import type { AvatarStatus } from '../voice/avatarMediaHost'
import { createConversationBinding } from '../voice/conversationBinding'
import { avatarBridge } from '../voice/avatarBridge'
import { connectVoiceClient, VoiceProtocolError, type VoiceClientConnection } from './voiceConnections'
import type { DH2DSession, DH2DSessionConfig, DH2DSessionEvents } from './types'

/** Compatible conversation facade. Its QR container outlives presentation;
 * no video/RTC player is constructed and remount never owns the conversation. */
export function createDH2DSession(parent: HTMLElement, config?: DH2DSessionConfig): DH2DSession {
  const resolved = hooks.dh2d.defaultConfig(config)
  if (!resolved.voiceClient) throw new Error('voiceClient configuration is required; SDK RTC transport was removed')
  const logger = hooks.logger.push((_, ...args) => _('[dh2d]', ...args))
  const scope = abortable(), evt = events<DH2DSessionEvents>()
  const container = document.createElement('div'); container.id = 'mt_dh2d_container'
  container.style.cssText = 'width:100%;height:100%;position:relative'; parent.appendChild(container)
  const binding = resolved.voiceClient.wechatPluginEndpoint
    ? createConversationBinding(resolved.voiceClient.wechatPluginEndpoint, container) : undefined
  let closed = false, terminated = false, connection: VoiceClientConnection | undefined, retirement: Promise<void> | undefined
  let status: DH2DSession['status'] = 'pending', mediaStatus: AvatarStatus = 'loading'
  let latestVoiceStatus: DHOutputMessage | undefined
  const buffered: DHInputMessage[] = []
  let selectedId = resolved.sessionId
  const setStatus = (next: DH2DSession['status']) => { status = next; if (next !== 'connected') latestVoiceStatus = undefined; evt.emit('statuschange', next) }
  const setMedia = (next: AvatarStatus) => { if (mediaStatus === next) return; mediaStatus = next; evt.emit('mediaStatus', next) }
  const on: typeof evt.on = (event, handler) => {
    const off = evt.on(event, handler)
    if (event === 'mediaStatus') (handler as (status: AvatarStatus) => void)(mediaStatus)
    if (event === 'message' && status === 'connected' && latestVoiceStatus) (handler as (value: DHOutputMessage) => void)({ ...latestVoiceStatus })
    return off
  }
  const session: DH2DSession = {
    get sessionId() { return selectedId }, get videoId() { return resolved.videoId }, get status() { return status },
    get mediaStatus() { return mediaStatus },
    async send(message) {
      if (closed || terminated) throw new Error('Trying to send message after session is closed')
      if (message.type === 'config') return // unchanged voice configuration behavior
      if (status === 'connected' && connection) await connection.send(message)
      else buffered.push(message)
    },
    async config() { /* unchanged voice configuration has no wire equivalent */ },
    on, off: evt.off,
    attachMedia() { return connection?.attachMedia() ?? Promise.resolve() },
    detachMedia() { return connection?.detachMedia() ?? Promise.resolve() },
    mountAvatar(selector) { avatarBridge().mount(selector, resolved.videoId) },
    unmountAvatar() { avatarBridge().unmount() },
    close() {
      if (retirement) return retirement
      closed = true; scope.abort()
      const closing = connection?.close()
      if (closing) void closing.catch(() => {})
      retirement = (async () => {
        try { await Promise.race([completed, new Promise(resolve => setTimeout(resolve, 3000))]) }
        catch (error: any) { if (error.message !== 'connection aborted') { setStatus('failed'); throw error } }
      })()
      return retirement
    },
  }
  function observe(current: VoiceClientConnection) {
    const off = [current.on('mediaStatus', setMedia), current.on('audio', value => { if (value instanceof ArrayBuffer || (typeof Blob !== 'undefined' && value instanceof Blob)) evt.emit('audio', value) }), current.on('message', message => {
      if (message.type === 'session_ended') { void session.close().catch(() => {}); return }
      if (message.type === 'status_change') latestVoiceStatus = { ...message }
      evt.emit('message', message)
    })]
    return () => off.forEach(unsubscribe => unsubscribe())
  }
  const completed = (async () => {
    try {
      await withChild(scope, child => hooks.dh2d.beforeConnectingSession(session, child))
      while (!closed) {
        let unobserve = () => {}
        const current = await withChild(scope, child => connectVoiceClient(logger, { container }, resolved, child, attempt => {
          connection = attempt
          unobserve = observe(attempt)
          return unobserve
        }, binding))
        selectedId = current.sessionId
        try {
          if (closed) return
          setStatus('connected')
          for (const message of buffered.splice(0)) await current.send(message)
          await withChild(scope, child => untilFailed(current, resolved.reconnectInterval, child))
          // Ordinary reconnect must buffer controls before joining the retired
          // owner. Terminal protocol errors throw past this transition.
          if (!closed) { setStatus('reconnecting'); setMedia('loading') }
        } finally { unobserve(); await current.close(); if (connection === current) connection = undefined }
      }
    } catch (error: any) {
      if (!closed) { setStatus('failed'); if (!(error instanceof VoiceProtocolError)) throw error }
    } finally {
      terminated = true; buffered.length = 0
      if (closed) setStatus('closed')
      try { await connection?.close() }
      finally { binding?.dispose(); container.remove(); await hooks.dh2d.afterClosingSession(session) }
    }
  })()
  void completed.catch(() => {})
  return session
}

/** Existing scheduled reconnect policy: idle at interval, otherwise next
 * sleeping/listening observation after the same interval. No media timer. */
async function untilFailed(connection: VoiceClientConnection, reconnectInterval: number, scope: ReturnType<typeof abortable>) {
  let status = 'sleeping', finish!: () => void
  const start = Date.now(), done = new Promise<void>(resolve => { finish = resolve })
  const unregister = scope.onabort(finish)
  const off = connection.on('message', message => {
    if (message.type !== 'status_change') return
    status = message.status
    if (reconnectInterval > 0 && ['sleeping', 'listening'].includes(status) && Date.now() - start > reconnectInterval) finish()
  })
  const timer = reconnectInterval > 0 ? setTimeout(() => { if (status === 'sleeping') finish() }, reconnectInterval) : undefined
  try { await Promise.race([done, connection.failure]) }
  catch (error) { if (error instanceof VoiceProtocolError) throw error }
  finally { if (timer !== undefined) clearTimeout(timer); off(); unregister() }
}
