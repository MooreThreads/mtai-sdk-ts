import { Logger } from '../types'

type StatsReport = {
  getStats?: () => Promise<RTCStatsReport> | RTCStatsReport
}

type ObservationContext = {
  turnId?: string,
  rtpTimestamp?: number | null,
  callbackNowMs?: number | null,
  performanceOriginMs?: number | null,
}

type ReceiverStatsOptions = {
  pc: StatsReport,
  logger?: Logger,
}

type Snapshot = {
  id: string,
  kind: 'audio' | 'video',
  ssrc: number | null,
  timestamp: number,
  values: Record<string, number>,
}

const COUNTERS = [
  'packetsLost', 'nackCount', 'pliCount', 'firCount', 'retransmittedPacketsReceived',
  'framesDecoded', 'freezeCount', 'totalDecodeTime', 'jitterBufferDelay',
  'jitterBufferTarget', 'jitterBufferMinimumDelay', 'jitterBufferEmittedCount',
  'concealedSamples', 'silentConcealedSamples', 'concealmentEvents',
  'totalSamplesReceived', 'audioSamplesReceived', 'audioSamplesDecoded',
  'insertedSamplesForDeceleration', 'removedSamplesForAcceleration',
] as const

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function reportEntries(report: any): any[] {
  if (report && typeof report.forEach === 'function') {
    const entries: any[] = []
    report.forEach((value: any) => entries.push(value))
    return entries
  }
  return []
}

function safeLog(logger: Logger | undefined, message: string) {
  try { logger?.log(message) } catch { /* diagnostics never affect media */ }
}

function safeError(logger: Logger | undefined, reason: string) {
  try { logger?.error(`receiver_stats_unavailable reason=${reason}`) } catch { /* isolated */ }
}

function snapshot(entry: any): Snapshot | null {
  if (entry?.type !== 'inbound-rtp' || (entry.kind !== 'audio' && entry.kind !== 'video')) return null
  const timestamp = finite(entry.timestamp)
  if (timestamp === null || typeof entry.id !== 'string') return null
  const values: Record<string, number> = {}
  for (const field of COUNTERS) {
    const value = finite(entry[field])
    if (value !== null) values[field] = value
  }
  return {
    id: entry.id,
    kind: entry.kind,
    ssrc: finite(entry.ssrc),
    timestamp,
    values,
  }
}

function delta(previous: number | undefined, current: number | undefined): number | null {
  if (previous === undefined || current === undefined || current < previous) return null
  return current - previous
}

function diagnosticName(field: string): string {
  return field.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
}

function interval(current: Snapshot, previous: Snapshot): Record<string, number | null> {
  const result: Record<string, number | null> = {}
  for (const field of COUNTERS) {
    const d = delta(previous.values[field], current.values[field])
    if (field === 'totalDecodeTime') continue
    result[`${diagnosticName(field)}_delta`] = d
  }
  const emitted = delta(previous.values.jitterBufferEmittedCount, current.values.jitterBufferEmittedCount)
  const delayDelta = delta(previous.values.jitterBufferDelay, current.values.jitterBufferDelay)
  const targetDelta = delta(previous.values.jitterBufferTarget, current.values.jitterBufferTarget)
  const minimumDelta = delta(previous.values.jitterBufferMinimumDelay, current.values.jitterBufferMinimumDelay)
  result.jitter_buffer_actual_mean_ms = emitted !== null && emitted > 0 && delayDelta !== null ? 1000 * delayDelta / emitted : null
  result.jitter_buffer_target_mean_ms = emitted !== null && emitted > 0 && targetDelta !== null ? 1000 * targetDelta / emitted : null
  result.jitter_buffer_minimum_mean_ms = emitted !== null && emitted > 0 && minimumDelta !== null ? 1000 * minimumDelta / emitted : null
  const decoderFrames = delta(previous.values.framesDecoded, current.values.framesDecoded)
  const decodeTime = delta(previous.values.totalDecodeTime, current.values.totalDecodeTime)
  result.decoder_mean_ms = decoderFrames !== null && decoderFrames > 0 && decodeTime !== null ? 1000 * decodeTime / decoderFrames : null
  return result
}

function identityChanged(current: Snapshot, previous: Snapshot): boolean {
  return current.id !== previous.id || current.kind !== previous.kind || current.ssrc !== previous.ssrc
}

export function createReceiverStats(options: ReceiverStatsOptions) {
  const getStats = options.pc?.getStats
  let stopped = false
  let busy = false
  let baseline = new Map<string, Snapshot>()

  function request(context: ObservationContext = {}) {
    if (stopped) return
    if (typeof getStats !== 'function') {
      safeError(options.logger, 'unsupported')
      return
    }
    if (busy) {
      safeError(options.logger, 'busy')
      return
    }
    busy = true
    // Promise continuation keeps getStats out of the synchronous media path.
    Promise.resolve().then(() => getStats.call(options.pc)).then(report => {
      if (stopped) return
      const current = new Map<string, Snapshot>()
      for (const entry of reportEntries(report)) {
        const item = snapshot(entry)
        if (item) current.set(item.id, item)
      }
      const intervalData: Record<string, Record<string, number | null>> = {}
      for (const [id, item] of current) {
        const previous = baseline.get(id)
        if (previous && item.timestamp > previous.timestamp && !identityChanged(item, previous)) {
          intervalData[item.kind] = interval(item, previous)
        }
      }
      const phase = baseline.size === 0 ? 'baseline' : 'interval'
      safeLog(options.logger, `receiver_stats phase=${phase} receiver_stats=${JSON.stringify({
        phase,
        turn: context.turnId ?? null,
        rtp_timestamp: finite(context.rtpTimestamp),
        performance_origin_ms: finite(context.performanceOriginMs),
        timestamp_ms: current.size ? Math.max(...[...current.values()].map(item => item.timestamp)) : null,
        video: intervalData.video ?? null,
        audio: intervalData.audio ?? null,
        reports: [...current.values()].map(item => ({ id: item.id, kind: item.kind, ssrc: item.ssrc })),
      })}`)
      baseline = current
    }).catch(() => {
      if (!stopped) safeError(options.logger, 'get_stats_failed')
    }).finally(() => { busy = false })
  }

  return {
    request,
    stop() {
      stopped = true
      baseline = new Map()
    },
  }
}
