import type { ConversationBinding } from '../voice/conversationBinding'
import { withChild } from '../abortable'
import type { Abortable, Logger } from '../types'
import type { DH2DPlayerElements, ResolvedDH2DSessionConfig } from './types'
import { createConversationConnection } from '../voice/conversation'
import { createAvatarMediaHost } from '../voice/avatarBridge'
import { validateVoiceSessionId, VoiceProtocolError } from '../voice/conversationProtocol'
export { VoiceProtocolError, voiceClientWebSocketUrl, sendVoiceClientMessage } from '../voice/conversationProtocol'

export type VoiceClientConnection = ReturnType<typeof createConversationConnection>

async function connectOnce(logger: Logger, elements: DH2DPlayerElements, config: ResolvedDH2DSessionConfig, scope: Abortable,
  observe?: (connection: VoiceClientConnection) => () => void, binding?: ConversationBinding): Promise<VoiceClientConnection> {
  const connection = createConversationConnection({ voice: { ...config.voiceClient!, sessionId: config.voiceClient!.sessionId! },
    videoId: config.videoId, mediaHost: createAvatarMediaHost(), logger, audioInput: config.audioInput, bindingContainer: elements.container, binding })
  const unobserve = observe?.(connection)
  const unregister = scope.onabort(() => { void connection.close().catch(() => {}) })
  try {
    await connection.ready
    return connection
  } catch (error) {
    unobserve?.()
    await connection.close()
    throw error
  } finally { unregister() }
}

/** Existing attempt timeout/retry coordinator; local attachment replaces only
 * RTC media. Media remount/failure never creates another conversation attempt. */
export async function connectVoiceClient(logger: Logger, elements: DH2DPlayerElements, config: ResolvedDH2DSessionConfig, abortable: Abortable,
  observe?: (connection: VoiceClientConnection) => () => void, binding?: ConversationBinding): Promise<VoiceClientConnection> {
  if (!config.voiceClient) throw new Error('voiceClient configuration is required')
  const sessionConfig = { ...config, voiceClient: { ...config.voiceClient, sessionId: config.voiceClient.sessionId || 'avatar-channel-session' } }
  validateVoiceSessionId(sessionConfig.voiceClient.sessionId)
  const rootLogger = logger.push((_, ...args) => _('[voice-connect]', ...args))
  for (let i = 0; ; i++) {
    try {
      return await withChild(abortable, async innerAbortable => {
        const tasks: Promise<VoiceClientConnection>[] = [connectOnce(rootLogger, elements, sessionConfig, innerAbortable, observe, binding)]
        const connectTimeout = config.connectTimeout
        if (connectTimeout > 0) tasks.push(new Promise<VoiceClientConnection>((_, reject) => {
          setTimeout(() => reject(new Error(`connect timeout after ${connectTimeout}ms`)), connectTimeout)
        }))
        try { return await Promise.race(tasks) }
        catch (error) {
          innerAbortable.abort()
          const [attempt] = await Promise.allSettled([tasks[0]])
          if (attempt.status === 'rejected' && attempt.reason instanceof VoiceProtocolError) throw attempt.reason
          throw error
        }
      })
    } catch (error: any) {
      rootLogger.error(error)
      if (error instanceof VoiceProtocolError || error.message === 'connection aborted') throw error
      await withChild(abortable, scope => new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 2000)
        scope.onabort(() => { clearTimeout(timer); reject(new Error('connection aborted')) })
      }))
    }
  }
}

export async function disconnectVoiceClient(_logger: Logger, connection: VoiceClientConnection) { await connection.close() }
