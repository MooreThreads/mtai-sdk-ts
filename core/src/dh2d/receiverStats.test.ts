describe('createReceiverStats', () => {
  function load() {
    try { return require('./receiverStats') as any } catch { return undefined }
  }
  function report(entries: Record<string, any>[]) {
    return new Map(entries.map(entry => [entry.id, entry]))
  }
  function logger(lines: string[]) {
    return { log: (line: string) => lines.push(line), warn: () => undefined,
      error: (line: string) => lines.push(line), debug: () => undefined, push() { return this } } as any
  }
  async function settled() { await new Promise<void>(resolve => setImmediate(resolve)) }

  test('preserves multiple reports and derives exact real-field interval ratios with context', async () => {
    const createReceiverStats = load()?.createReceiverStats
    expect(typeof createReceiverStats).toBe('function')
    const lines: string[] = []
    const reports = [
      report([
        { id: 'v1', type: 'inbound-rtp', kind: 'video', ssrc: 7, timestamp: 100, packetsLost: -2, framesDecoded: 10, totalDecodeTime: 1, jitterBufferDelay: 2, jitterBufferTargetDelay: 4, jitterBufferMinimumDelay: 1, jitterBufferEmittedCount: 4 },
        { id: 'v2', type: 'inbound-rtp', kind: 'video', ssrc: 9, timestamp: 100, packetsLost: 1, framesDecoded: 20, totalDecodeTime: 2, jitterBufferDelay: 1, jitterBufferTargetDelay: 2, jitterBufferMinimumDelay: 0.5, jitterBufferEmittedCount: 2 },
        { id: 'a1', type: 'inbound-rtp', kind: 'audio', ssrc: 8, timestamp: 100, packetsLost: 3, concealedSamples: 5, jitterBufferDelay: 1, jitterBufferEmittedCount: 2 },
      ]),
      report([
        { id: 'v1', type: 'inbound-rtp', kind: 'video', ssrc: 7, timestamp: 160, packetsLost: -5, framesDecoded: 14, totalDecodeTime: 1.4, jitterBufferDelay: 3, jitterBufferTargetDelay: 5.2, jitterBufferMinimumDelay: 1.6, jitterBufferEmittedCount: 6, freezeCount: 1, nackCount: Number.POSITIVE_INFINITY },
        { id: 'v2', type: 'inbound-rtp', kind: 'video', ssrc: 9, timestamp: 160, packetsLost: 4, framesDecoded: 22, totalDecodeTime: 2.2, jitterBufferDelay: 2, jitterBufferTargetDelay: 3, jitterBufferMinimumDelay: 0.9, jitterBufferEmittedCount: 4 },
        { id: 'a1', type: 'inbound-rtp', kind: 'audio', ssrc: 8, timestamp: 160, packetsLost: 4, concealedSamples: 8, jitterBufferDelay: 2, jitterBufferEmittedCount: 4 },
      ]),
    ]
    const stats = createReceiverStats({ pc: { getStats: jest.fn(async () => reports.shift()) }, logger: logger(lines) })
    stats.request({ turnId: 'A2', rtpTimestamp: 900, callbackNowMs: 12, performanceOriginMs: 1000 })
    await settled()
    stats.request({ turnId: 'A3', rtpTimestamp: 901, callbackNowMs: 13, performanceOriginMs: 1000 })
    await settled()
    const baseline = JSON.parse(lines[0].split(' receiver_stats=')[1])
    const interval = JSON.parse(lines[1].split(' receiver_stats=')[1])
    expect(baseline.reports).toHaveLength(3)
    expect(interval).toEqual(expect.objectContaining({ turn: 'A3', rtp_timestamp: 901, callback_now_ms: 13, performance_origin_ms: 1000 }))
    expect(interval.reports).toHaveLength(3)
    const v1 = interval.reports.find((item: any) => item.id === 'v1')
    const v2 = interval.reports.find((item: any) => item.id === 'v2')
    expect(v1).toEqual(expect.objectContaining({ previous_timestamp_ms: 100, timestamp_ms: 160, interval_ms: 60, kind: 'video', ssrc: 7 }))
    expect(v1.counters.packets_lost).toEqual({ value: -5, delta: -3, unit: 'packets' })
    expect(v1.counters.nack_count).toEqual({ value: null, delta: null, unit: 'count' })
    expect(v1.counters.freeze_count).toEqual({ value: 1, delta: null, unit: 'count' })
    expect(v1.derived.jitter_buffer_actual_delay_ms).toBe(500)
    expect(v1.derived.jitter_buffer_target_delay_ms).toBeCloseTo(600, 10)
    expect(v1.derived.jitter_buffer_minimum_delay_ms).toBeCloseTo(300, 10)
    expect(v1.derived.decoder_mean_ms).toBeCloseTo(100, 10)
    expect(v2.counters.frames_decoded).toEqual({ value: 22, delta: 2, unit: 'frames' })
    expect(interval.reports).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'v1', kind: 'audio' })]))
    expect(lines.join(' ')).not.toContain('totalDecodeTime')
  })

  test('suppresses identity, missing-SSRC, reset and nonmonotonic intervals then accepts a fresh generation', async () => {
    const createReceiverStats = load()?.createReceiverStats
    expect(typeof createReceiverStats).toBe('function')
    const lines: string[] = []
    const reports = [
      report([{ id: 'r', type: 'inbound-rtp', kind: 'video', ssrc: 1, timestamp: 100, framesDecoded: 2, packetsLost: 5 }]),
      report([{ id: 'r', type: 'inbound-rtp', kind: 'video', ssrc: 2, timestamp: 160, framesDecoded: 4, packetsLost: 7 }, { id: 'missing', type: 'inbound-rtp', kind: 'video', timestamp: 160, framesDecoded: 4 }]),
      report([{ id: 'r', type: 'inbound-rtp', kind: 'video', ssrc: 2, timestamp: Number.NaN, framesDecoded: 1, packetsLost: 8 }]),
      report([{ id: 'r', type: 'inbound-rtp', kind: 'video', ssrc: 2, timestamp: 150, framesDecoded: 3, packetsLost: 10 }]),
      report([{ id: 'r', type: 'inbound-rtp', kind: 'video', ssrc: 2, timestamp: 210, framesDecoded: 2, packetsLost: 11 }]),
      report([{ id: 'r', type: 'inbound-rtp', kind: 'video', ssrc: 2, timestamp: 270, framesDecoded: 4, packetsLost: 12 }]),
    ]
    const stats = createReceiverStats({ pc: { getStats: jest.fn(async () => reports.shift()) }, logger: logger(lines) })
    for (let i = 0; i < 6; i++) { stats.request({ turnId: `A${i}` }); await settled() }
    const records = lines.filter(line => line.includes(' receiver_stats=')).map(line => JSON.parse(line.split(' receiver_stats=')[1]))
    expect(records[1].reports.find((item: any) => item.id === 'r').interval_ms).toBeNull()
    expect(records[1].reports.find((item: any) => item.id === 'missing').interval_ms).toBeNull()
    expect(records[2].reports.find((item: any) => item.id === 'r')).toEqual(expect.objectContaining({ timestamp_ms: null, interval_ms: null }))
    expect(records[3].reports.find((item: any) => item.id === 'r').interval_ms).toBeNull()
    const reset = records[4].reports.find((item: any) => item.id === 'r')
    expect(reset).toEqual(expect.objectContaining({ interval_ms: null, derived: expect.objectContaining({ decoder_mean_ms: null }) }))
    expect(reset.counters.frames_decoded).toEqual({ value: 2, delta: null, unit: 'frames' })
    expect(records[5].reports.find((item: any) => item.id === 'r')).toEqual(expect.objectContaining({ previous_timestamp_ms: 210, timestamp_ms: 270, interval_ms: 60 }))
    expect(records[5].reports.find((item: any) => item.id === 'r').counters.frames_decoded.delta).toBe(2)
    expect(records[5].reports.find((item: any) => item.id === 'r').counters.packets_lost.delta).toBe(1)
  })

  test('reports busy and getStats failure with fixed reasons, and stop fences a late result without vacuous assertions', async () => {
    const createReceiverStats = load()?.createReceiverStats
    expect(typeof createReceiverStats).toBe('function')
    let release!: (value: any) => void
    const pending = new Promise(resolve => { release = resolve })
    const lines: string[] = []
    let calls = 0
    const getStats = jest.fn(() => calls++ === 0 ? Promise.reject(new Error('secret')) : pending)
    const stats = createReceiverStats({ pc: { getStats }, logger: { ...logger(lines), log: () => { throw new Error('sink') } } })
    stats.request({ turnId: 'failed' })
    await settled()
    expect(lines).toContain('receiver_stats_unavailable reason=get_stats_failed')
    stats.request({ turnId: 'busy' })
    stats.request({ turnId: 'dropped' })
    expect(lines).toContain('receiver_stats_unavailable reason=busy')
    stats.stop()
    release(report([{ id: 'late', type: 'inbound-rtp', kind: 'audio', ssrc: 4, timestamp: 1, packetsLost: 1 }]))
    await settled()
    expect(getStats).toHaveBeenCalledTimes(1)
    expect(lines.filter(line => line.includes('receiver_stats=')).length).toBe(0)

    const retiredLines: string[] = []
    const retiredGetStats = jest.fn(async () => report([{ id: 'retired', type: 'inbound-rtp', kind: 'audio', ssrc: 5, timestamp: 2, packetsLost: 1 }]))
    const retired = createReceiverStats({ pc: { getStats: retiredGetStats }, logger: logger(retiredLines) })
    retired.request({ turnId: 'retired' })
    retired.stop()
    await settled()
    expect(retiredGetStats).not.toHaveBeenCalled()
    expect(retiredLines).toEqual([])
  })
})
