import { VoiceMicrophone } from './microphone'

/** Commands execute microphone actions; snapshots never call this controller. */
export function createVoiceInputControl(options: {
  sessionId: string,
  create: (onPcm: (data: Uint8Array) => void, onLost: () => void) => VoiceMicrophone,
  send: (frame: any) => void,
}) {
  let current: { session_id: string, state_epoch: string, source_revision: number } | undefined
  let microphone: VoiceMicrophone | undefined
  let ready = false
  let turn: string | undefined
  let generation = 0
  let disposed = false
  let captureGeneration = 0
  const retiredTurns = new Set<string>()
  let pendingRelease: Promise<void> | undefined
  function retireCapture() {
    captureGeneration++
    if (turn) retiredTurns.add(turn)
    turn = undefined
    microphone?.setOnPcm(() => undefined)
  }
  function release() {
    generation++
    retireCapture()
    ready = false
    const old = microphone
    microphone = undefined
    if (old) {
      const stopped = old.stop()
      const operation = Promise.all([pendingRelease, old.ready.catch(() => undefined), stopped]).then(() => undefined)
      pendingRelease = operation
      void operation.then(() => { if (pendingRelease === operation) pendingRelease = undefined }, () => undefined)
    }
    return pendingRelease
  }
  function ingest(event: any): boolean {
    if (!['audio.input.prepare', 'audio.input.release', 'capture.start', 'capture.stop'].includes(event.type)) return false
    if (disposed || event.session_id !== options.sessionId || typeof event.state_epoch !== 'string'
        || !Number.isInteger(event.source_revision) || event.source_revision < 0) return true
    const identity = { session_id: options.sessionId, state_epoch: event.state_epoch, source_revision: event.source_revision }
    if (event.type === 'audio.input.prepare') {
      if (current && (identity.state_epoch !== current.state_epoch || identity.source_revision <= current.source_revision)) return true
      const prior = release()
      current = identity
      const token = generation
      void (async () => {
        let created = false
        try {
          if (prior) await prior
          if (disposed || token !== generation) return
          microphone = options.create(() => undefined, () => {
            if (disposed || token !== generation) return
            release()
            options.send({ type: 'audio.input.error', ...identity, code: 'device_lost' })
          })
          created = true
          await microphone.ready
          if (disposed || token !== generation) return
          ready = true
          options.send({ type: 'audio.input.ready', ...identity })
        } catch {
          if (disposed || token !== generation) return
          release()
          options.send({ type: 'audio.input.error', ...identity, code: created ? 'initialization_failed' : 'unavailable' })
        }
      })()
      return true
    }
    if (!current || identity.state_epoch !== current.state_epoch || identity.source_revision !== current.source_revision) return true
    if (event.type === 'audio.input.release') {
      const completed = release()
      void Promise.resolve(completed).then(() => {
        if (!disposed) options.send({ type: 'audio.input.released', ...identity })
      })
    } else if (typeof event.turn_id === 'string' && event.turn_id) {
      if (event.type === 'capture.start' && ready && !retiredTurns.has(event.turn_id) && turn !== event.turn_id) {
        retireCapture()
        const capturedTurn: string = event.turn_id
        turn = capturedTurn
        const capturedGeneration = captureGeneration
        const preparedGeneration = generation
        microphone?.setOnPcm(data => {
          if (disposed || preparedGeneration !== generation || capturedGeneration !== captureGeneration || !ready) return
          options.send({ type: 'audio.input.delta', direction: 'input', ...identity, turn_id: capturedTurn, byte_count: data.byteLength })
          options.send(data)
        })
        options.send({ type: 'capture.started', ...identity, turn_id: capturedTurn })
      } else if (event.type === 'capture.stop' && turn === event.turn_id) {
        retireCapture()
        options.send({ type: 'capture.stopped', ...identity, turn_id: event.turn_id })
      }
    }
    return true
  }
  return { ingest,
    synchronize() { release(); current = undefined; retiredTurns.clear() },
    dispose() { disposed = true; release() },
  }
}
