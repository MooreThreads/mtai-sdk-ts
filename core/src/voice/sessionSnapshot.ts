import { DHOutputMessage } from '../types'

/** Full replacement projection only: never sends intents or microphone commands. */
export function createSessionSnapshotProjection(sessionId: string) {
  let epoch: string | undefined
  let revision = -1
  let latest: DHOutputMessage[] = []
  function ingest(event: any): DHOutputMessage[] {
    if (event?.type !== 'session.snapshot' || event.session_id !== sessionId
        || typeof event.state_epoch !== 'string' || !event.state_epoch
        || !Number.isInteger(event.revision) || event.revision < 0
        || (epoch !== undefined && event.state_epoch !== epoch) || event.revision <= revision) return []
    const conversation = event.state?.conversation
    const input = event.state?.audio_input
    if (!conversation || !input || !['ended', 'voice', 'text'].includes(conversation.state)
        || !['idle', 'starting', 'waiting_playback', 'capturing', 'responding', 'stopping'].includes(conversation.phase)
        || ![null, 'frontend', 'xunfei'].includes(input.source)
        || !['unavailable', 'preparing', 'ready', 'capturing', 'error'].includes(input.status)
        || !Number.isInteger(input.source_revision) || input.source_revision < 0
        || (input.status === 'capturing') !== (conversation.phase === 'capturing')
        || (input.status === 'capturing' && conversation.state !== 'voice')
        || (input.source === null && !['unavailable', 'error'].includes(input.status))
        || (input.error_code !== undefined && (input.status !== 'error'
          || !['unavailable', 'permission_denied', 'device_lost', 'format_mismatch', 'initialization_failed'].includes(input.error_code)))
        || (input.status === 'capturing'
          ? typeof input.capture_turn_id !== 'string' || !input.capture_turn_id || input.source === null
          : input.capture_turn_id !== null)) return []
    epoch = event.state_epoch
    revision = event.revision
    const status = conversation.state === 'ended' ? 'sleeping'
      : input.status === 'capturing' ? 'listening'
      : ['responding', 'waiting_playback'].includes(conversation.phase) ? 'talking' : 'sleeping'
    latest = [{ type: 'status_change', status }]
    return latest.map(message => ({ ...message }))
  }
  return { ingest, replay: () => latest.map(message => ({ ...message })) }
}
