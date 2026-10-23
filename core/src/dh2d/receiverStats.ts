import { Logger } from '../types'

type StatsReport = { getStats?: () => Promise<RTCStatsReport> | RTCStatsReport }
type ObservationContext = { turnId?: string, rtpTimestamp?: number | null, callbackNowMs?: number | null, performanceOriginMs?: number | null }
type ReceiverStatsOptions = { pc: StatsReport, logger?: Logger }
type Field = typeof FIELDS[number]
type Snapshot = { id: string, kind: 'audio' | 'video', ssrc: number | null, timestamp: number | null, values: Record<Field, number | null> }

const FIELDS = [
  'packetsLost', 'nackCount', 'pliCount', 'firCount', 'retransmittedPacketsReceived',
  'framesDecoded', 'freezeCount', 'totalDecodeTime', 'jitterBufferDelay',
  'jitterBufferTargetDelay', 'jitterBufferMinimumDelay', 'jitterBufferEmittedCount',
  'concealedSamples', 'silentConcealedSamples', 'concealmentEvents',
  'totalSamplesReceived', 'audioSamplesReceived', 'audioSamplesDecoded',
  'insertedSamplesForDeceleration', 'removedSamplesForAcceleration',
] as const

const UNITS: Record<Field, string> = {
  packetsLost: 'packets', nackCount: 'count', pliCount: 'count', firCount: 'count',
  retransmittedPacketsReceived: 'packets', framesDecoded: 'frames', freezeCount: 'count',
  totalDecodeTime: 'seconds', jitterBufferDelay: 'seconds', jitterBufferTargetDelay: 'seconds',
  jitterBufferMinimumDelay: 'seconds', jitterBufferEmittedCount: 'count', concealedSamples: 'samples',
  silentConcealedSamples: 'samples', concealmentEvents: 'count', totalSamplesReceived: 'samples',
  audioSamplesReceived: 'samples', audioSamplesDecoded: 'samples',
  insertedSamplesForDeceleration: 'samples', removedSamplesForAcceleration: 'samples',
}

function finite(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null }
function safeLog(logger: Logger | undefined, line: string) { try { logger?.log(line) } catch { /* diagnostic sink is isolated */ } }
function safeUnavailable(logger: Logger | undefined, reason: 'unsupported' | 'busy' | 'get_stats_failed') { try { logger?.error(`receiver_stats_unavailable reason=${reason}`) } catch { /* fixed diagnostic only */ } }
function entries(report: any): any[] {
  if (!report || typeof report.forEach !== 'function') return []
  const result: any[] = []
  try { report.forEach((value: any) => result.push(value)) } catch { return [] }
  return result
}
function snapshot(entry: any): Snapshot | null {
  if (entry?.type !== 'inbound-rtp' || (entry.kind !== 'audio' && entry.kind !== 'video') || typeof entry.id !== 'string') return null
  const values = {} as Record<Field, number | null>
  for (const field of FIELDS) values[field] = finite(entry[field])
  return { id: entry.id, kind: entry.kind, ssrc: finite(entry.ssrc), timestamp: finite(entry.timestamp), values }
}
function name(field: string) { return field.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`) }
function monotonicDelta(field: Field, previous: number | null, current: number | null): number | null {
  if (previous === null || current === null) return null
  if (field !== 'packetsLost' && current < previous) return null
  const result = current - previous
  return Number.isFinite(result) ? result : null
}
function ratio(deltaValue: number | null, emitted: number | null): number | null {
  if (deltaValue === null || emitted === null || emitted <= 0) return null
  const result = 1000 * deltaValue / emitted
  return Number.isFinite(result) ? result : null
}
function reportRecord(current: Snapshot, previous?: Snapshot) {
  const identity = previous && (previous.kind !== current.kind || previous.ssrc === null || current.ssrc === null || previous.ssrc !== current.ssrc)
  const timestampValid = previous?.timestamp !== null && previous?.timestamp !== undefined && current.timestamp !== null
    && current.timestamp > previous.timestamp && Number.isFinite(current.timestamp - previous.timestamp)
  const sharedReset = previous !== undefined && FIELDS.some(field => field !== 'packetsLost'
    && previous.values[field] !== null && current.values[field] !== null && current.values[field]! < previous.values[field]!)
  const intervalMs = !identity && timestampValid && !sharedReset ? current.timestamp! - previous!.timestamp! : null
  const validInterval = previous !== undefined && intervalMs !== null
  const counters: Record<string, { value: number | null, delta: number | null, unit: string }> = {}
  for (const field of FIELDS) {
    const value = current.values[field]
    counters[name(field)] = { value, delta: validInterval ? monotonicDelta(field, previous!.values[field], value) : null, unit: UNITS[field] }
  }
  const emitted = validInterval ? monotonicDelta('jitterBufferEmittedCount', previous!.values.jitterBufferEmittedCount, current.values.jitterBufferEmittedCount) : null
  const derived = {
    jitter_buffer_actual_delay_ms: ratio(validInterval ? monotonicDelta('jitterBufferDelay', previous!.values.jitterBufferDelay, current.values.jitterBufferDelay) : null, emitted),
    jitter_buffer_target_delay_ms: ratio(validInterval ? monotonicDelta('jitterBufferTargetDelay', previous!.values.jitterBufferTargetDelay, current.values.jitterBufferTargetDelay) : null, emitted),
    jitter_buffer_minimum_delay_ms: ratio(validInterval ? monotonicDelta('jitterBufferMinimumDelay', previous!.values.jitterBufferMinimumDelay, current.values.jitterBufferMinimumDelay) : null, emitted),
    decoder_mean_ms: ratio(validInterval ? monotonicDelta('totalDecodeTime', previous!.values.totalDecodeTime, current.values.totalDecodeTime) : null,
      validInterval ? monotonicDelta('framesDecoded', previous!.values.framesDecoded, current.values.framesDecoded) : null),
  }
  return { id: current.id, kind: current.kind, ssrc: current.ssrc, previous_timestamp_ms: previous?.timestamp ?? null, timestamp_ms: current.timestamp, interval_ms: intervalMs, counters, derived }
}

export function createReceiverStats(options: ReceiverStatsOptions) {
  const getStats = options.pc?.getStats
  let stopped = false
  let busy = false
  let baseline = new Map<string, Snapshot>()
  function request(context: ObservationContext = {}) {
    if (stopped) return
    if (typeof getStats !== 'function') { safeUnavailable(options.logger, 'unsupported'); return }
    if (busy) { safeUnavailable(options.logger, 'busy'); return }
    busy = true
    Promise.resolve().then(() => getStats.call(options.pc)).then(report => {
      if (stopped) return
      const current = new Map<string, Snapshot>()
      for (const item of entries(report)) {
        const parsed = snapshot(item)
        if (parsed) current.set(parsed.id, parsed)
      }
      const records = [...current.values()].map(item => reportRecord(item, baseline.get(item.id)))
      const phase = baseline.size === 0 ? 'baseline' : 'interval'
      safeLog(options.logger, `receiver_stats phase=${phase} receiver_stats=${JSON.stringify({
        phase, turn: context.turnId ?? null, rtp_timestamp: finite(context.rtpTimestamp),
        callback_now_ms: finite(context.callbackNowMs), performance_origin_ms: finite(context.performanceOriginMs), reports: records,
      })}`)
      baseline = current
    }).catch(() => { if (!stopped) safeUnavailable(options.logger, 'get_stats_failed') }).finally(() => { busy = false })
  }
  return { request, stop() { stopped = true; baseline = new Map() } }
}
