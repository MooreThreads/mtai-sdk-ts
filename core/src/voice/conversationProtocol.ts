import type { DHInputMessage } from '../types'
import type { VoiceClientFrame, VoiceMessageAdapter } from './adapter'
import type { VoiceClientToolCall, VoiceClientToolResult } from './channelBinding'

/** A rejected version handshake is terminal, rather than a media reconnect. */
export class VoiceProtocolError extends Error {}

export function isFrontendToolCall(value: unknown): value is VoiceClientToolCall {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const message = value as Record<string, unknown>
  const arguments_ = message.arguments
  return message.type === 'tool.call'
    && typeof message.session_id === 'string' && message.session_id.length > 0
    && typeof message.turn_id === 'string' && message.turn_id.length > 0
    && typeof message.call_id === 'string' && message.call_id.length > 0
    && typeof message.name === 'string' && message.name.length > 0
    && arguments_ !== null && typeof arguments_ === 'object' && !Array.isArray(arguments_)
}

function isFrontendToolResult(value: unknown): value is VoiceClientToolResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  if (result.ok === true) {
    return result.result !== null && typeof result.result === 'object' && !Array.isArray(result.result)
  }
  if (result.ok === false) {
    const error = result.error
    return error !== null && typeof error === 'object' && !Array.isArray(error)
      && typeof (error as Record<string, unknown>).code === 'string'
      && typeof (error as Record<string, unknown>).message === 'string'
  }
  return false
}

export function isSerializedFrontendToolResult(
  value: unknown, call: VoiceClientToolCall,
): value is Record<string, unknown> & VoiceClientToolResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const frame = value as Record<string, unknown>
  return frame.type === 'tool.result' && frame.session_id === call.session_id
    && frame.turn_id === call.turn_id && frame.call_id === call.call_id
    && isFrontendToolResult(frame)
}

export const FRONTEND_TOOL_FAILURE: VoiceClientToolResult = {
  ok: false, error: { code: 'frontend_tool_failed', message: 'frontend tool failed' },
}
const SAFE_FRONTEND_ERROR_MESSAGES: Record<string, readonly string[]> = {
  invalid_arguments: ['invalid binding arguments', 'channel must be "wechat"'],
  invalid_request: ['WeChat binding request was invalid'],
  unknown_operation: ['WeChat binding operation is no longer available'],
  binding_unavailable: ['WeChat binding service unavailable'],
  frontend_tool_failed: ['frontend tool failed'],
}

export function sanitizeFrontendToolResult(value: unknown): VoiceClientToolResult {
  if (!isFrontendToolResult(value)) return FRONTEND_TOOL_FAILURE
  if (value.ok) return { ok: true, result: value.result }
  const code = value.error.code
  const messages = SAFE_FRONTEND_ERROR_MESSAGES[code]
  if (!messages) return FRONTEND_TOOL_FAILURE
  const message = messages.includes(value.error.message) ? value.error.message : messages[0]
  return { ok: false, error: { code, message } }
}

export function validateVoiceSessionId(sessionId: string): void {
  // URL normalization would interpret even encoded dot-only IDs as navigation.
  if (sessionId === '.' || sessionId === '..') throw new Error('voice client sessionId must not be "." or ".."')
}

/** Same client endpoint, mode and query vocabulary as the existing avatar path. */
export function voiceClientWebSocketUrl(base: string, videoId: string, sessionId: string): string {
  validateVoiceSessionId(sessionId)
  const url = new URL(base)
  if (url.protocol === 'https:') url.protocol = 'wss:'
  else if (url.protocol === 'http:') url.protocol = 'ws:'
  if (!url.pathname || url.pathname === '/') url.pathname = '/ws'
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${encodeURIComponent(sessionId)}`
  url.searchParams.set('mode', 'avatar')
  url.searchParams.set('video_id', videoId)
  return url.toString()
}

/** Preserve the current app-to-client translations; config/ping are ignored. */
export async function sendVoiceClientMessage(
  ws: Pick<WebSocket, 'send'>, adapter: VoiceMessageAdapter, message: DHInputMessage,
): Promise<void> {
  let frames: VoiceClientFrame[] = []
  switch (message.type) {
    case 'wakeup': frames = adapter.wakeup(message.text); break
    case 'sleep': frames = adapter.sleep(message.text); break
    case 'input': {
      const botText = typeof message.bot_text === 'string' ? message.bot_text.trim() : ''
      if (botText || message.text?.trim() !== '/clear') adapter.invalidatePendingSequence()
      if (botText) throw new Error(
        'voice client mode cannot send input bot_text: the client protocol has no bot-authored text input; use text instead or the legacy direct-DH2D mode',
      )
      if (message.text && message.text.trim()) frames = [adapter.textInput(message.text)]
      break
    }
    case 'asr_session':
      if (message.command !== 'start' && message.command !== 'stop') throw new Error(
        `voice client mode cannot map asr_session command ${JSON.stringify(message.command)}: expected 'start' or 'stop'`,
      )
      if (message.should_respond === false) throw new Error(
        'voice client mode cannot map asr_session should_respond=false: ASR finals in an active conversation always generate a response',
      )
      frames = adapter.asrSession(message.command)
      break
  }
  frames.forEach(frame => ws.send(JSON.stringify(frame)))
}
