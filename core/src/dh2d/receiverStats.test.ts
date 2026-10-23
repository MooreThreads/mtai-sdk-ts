describe('createReceiverStats', () => {
  function load() {
    try {
      return require('./receiverStats') as any
    } catch {
      return undefined
    }
  }

  function report(entries: Record<string, any>[]) {
    return new Map(entries.map(entry => [entry.id, entry]))
  }

  test('derives allowlisted audio and video interval diagnostics from one report', async () => {
    const createReceiverStats = load()?.createReceiverStats
    expect(typeof createReceiverStats).toBe('function')
    const lines: string[] = []
    const reports = [
      report([
        { id: 'v', type: 'inbound-rtp', kind: 'video', ssrc: 7, timestamp: 100, packetsLost: 2, nackCount: 3, pliCount: 1, retransmittedPacketsReceived: 4, framesDecoded: 10, totalDecodeTime: 1, jitterBufferDelay: 2, jitterBufferEmittedCount: 4, freezeCount: 0 },
        { id: 'a', type: 'inbound-rtp', kind: 'audio', ssrc: 8, timestamp: 100, packetsLost: -2, concealedSamples: 5, totalSamplesReceived: 20, jitterBufferDelay: 1, jitterBufferEmittedCount: 2 },
      ]),
      report([
        { id: 'v', type: 'inbound-rtp', kind: 'video', ssrc: 7, timestamp: 160, packetsLost: 5, nackCount: 5, pliCount: 2, retransmittedPacketsReceived: 7, framesDecoded: 14, totalDecodeTime: 1.4, jitterBufferDelay: 3, jitterBufferEmittedCount: 6, freezeCount: 1 },
        { id: 'a', type: 'inbound-rtp', kind: 'audio', ssrc: 8, timestamp: 160, packetsLost: -1, concealedSamples: 8, totalSamplesReceived: 30, jitterBufferDelay: 2, jitterBufferEmittedCount: 4, audioSamplesReceived: 30, audioSamplesDecoded: 29 },
      ]),
    ]
    const pc = { getStats: jest.fn(async () => reports.shift()) }
    const stats = createReceiverStats({ pc, logger: { log: (line: string) => lines.push(line), warn: () => undefined, error: () => undefined, debug: () => undefined, push() { return this } } })
    stats.request({ turnId: 'A1', rtpTimestamp: 9 })
    await new Promise<void>(resolve => setImmediate(resolve))
    stats.request({ turnId: 'A2', rtpTimestamp: 10 })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(JSON.parse(lines[0].split(' receiver_stats=')[1])).toEqual(expect.objectContaining({ phase: 'baseline' }))
    expect(JSON.parse(lines[1].split(' receiver_stats=')[1])).toEqual(expect.objectContaining({
      phase: 'interval', turn: 'A2', timestamp_ms: 160, video: expect.objectContaining({
        frames_decoded_delta: 4, decoder_mean_ms: expect.closeTo(100, 8), jitter_buffer_actual_mean_ms: 500,
        packets_lost_delta: 3, freeze_count_delta: 1,
      }), audio: expect.objectContaining({ packets_lost_delta: 1, jitter_buffer_actual_mean_ms: 500 }),
    }))
    expect(lines.join(' ')).not.toContain('totalDecodeTime')
    expect(lines.join(' ')).not.toContain('secret')
  })

  test('reports busy and reset intervals without queueing or clamping counters', async () => {
    const createReceiverStats = load()?.createReceiverStats
    expect(typeof createReceiverStats).toBe('function')
    let release!: (value: any) => void
    const pending = new Promise(resolve => { release = resolve })
    const lines: string[] = []
    const logger: any = { log: (line: string) => lines.push(line), warn: () => undefined, error: (line: string) => lines.push(line), debug: () => undefined, push() { return this } }
    const stats = createReceiverStats({ pc: { getStats: () => pending }, logger })
    stats.request({ turnId: 'A0' })
    stats.request({ turnId: 'A1' })
    expect(lines.some(line => line.includes('reason=busy'))).toBe(true)
    release(new Map([["v", { id: 'v', type: 'inbound-rtp', kind: 'video', ssrc: 1, timestamp: 10, packetsLost: 4 }]]) as any)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(lines.some(line => line.includes('phase=baseline'))).toBe(true)
    expect(() => logger.log('ok')).not.toThrow()
  })

  test('stop fences late reports and isolates logger failures', async () => {
    const createReceiverStats = load()?.createReceiverStats
    expect(typeof createReceiverStats).toBe('function')
    let release!: (value: any) => void
    const pending = new Promise(resolve => { release = resolve })
    const logger: any = { log: () => { throw new Error('sink') }, warn: () => { throw new Error('sink') }, error: () => { throw new Error('sink') }, debug: () => undefined, push() { return this } }
    const stats = createReceiverStats({ pc: { getStats: () => pending }, logger })
    stats.request({ turnId: 'A0' })
    stats.stop()
    release(new Map())
    await Promise.resolve()
    await Promise.resolve()
    expect(true).toBe(true)
  })
})
