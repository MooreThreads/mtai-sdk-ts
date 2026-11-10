import { createAvatarPlayback, AvatarFrameContext } from './avatarMedia'
import { AvatarStripeReadback, StripePixels, StripeReadbackSample } from './avatarStripeReadback'
import { crc16 } from './turnStripe'

function pixels(token: string, width = 64): StripePixels {
  const bytes = [2, 1, token.charCodeAt(0), token.charCodeAt(1)]
  const crc = crc16(Uint8Array.from(bytes)); bytes.push(crc >> 8, crc & 255)
  const data = new Uint8Array(width * 12 * 4)
  for (let y = 0; y < 12; y++) for (let x = 0; x < width; x++) {
    const bit = Math.floor(y / 4) * 16 + Math.floor((x % 64) / 4)
    const value = bytes[bit >> 3] & (1 << (7 - bit % 8)) ? 235 : 16
    const i = (y * width + x) * 4
    data[i] = data[i + 1] = data[i + 2] = value; data[i + 3] = 255
  }
  return { data, width, height: 12 }
}
function scheduler<T extends (...args: any[]) => void>() {
  let callback: T | undefined
  const history: T[] = []
  return {
    request(fn: T) { callback = fn; history.push(fn); return () => { if (callback === fn) callback = undefined } },
    emit(...args: Parameters<T>) { const fn = callback; callback = undefined; fn?.(...args) },
    late(index: number, ...args: Parameters<T>) { history[index]?.(...args) },
  }
}
/** Deterministic component fixture: readiness, loss and captured pixels are test inputs. */
class Reader implements AvatarStripeReadback<AvatarFrameContext> {
  image = pixels('A0')
  ready = false
  readySequences = new Set<number>()
  lost = false
  disposed = false
  prepared: StripePixels | undefined
  queue: { image: StripePixels, context: AvatarFrameContext }[] = []
  prepare() { if (this.lost) throw Error('context_lost'); this.prepared = this.image; return true }
  submit(context: AvatarFrameContext) { if (this.queue.length === 2) throw Error('overflow'); this.queue.push({ image: this.prepared!, context }) }
  take(blocking: boolean): StripeReadbackSample<AvatarFrameContext> | null {
    if (this.lost) throw Error('context_lost')
    if (!this.queue.length) return null
    if (!blocking && !this.ready && !this.readySequences.has(this.queue[0].context.sequence)) return null
    const item = this.queue.shift()
    return item ? { ...item, timing: { import_start_ms: 1, import_end_ms: 2, submission_start_ms: 1, submission_end_ms: 3,
      ready_observed_ms: blocking ? null : 4, copy_start_ms: 4, copy_end_ms: 5, synchronous_drain: blocking } } : null
  }
  retireReady() { const out: StripeReadbackSample<AvatarFrameContext>[] = []; while (this.queue.length) { const item = this.take(false); if (!item) break; out.push(item) } return out }
  retireOldestBlocking() { return this.take(true) }
  get pending() { return this.queue.length }
  dispose() { this.disposed = true; this.queue = [] }
}
function fixture(onObserved?: (id: string) => void) {
  const video = scheduler<(now?: number, metadata?: Partial<VideoFrameCallbackMetadata>) => void>()
  const animation = scheduler<() => void>()
  const readers: Reader[] = [], seen: string[] = [], ended: string[] = [], logs: string[] = [], changed: string[] = []
  let fallback = pixels('C2')
  const playback = createAvatarPlayback({ requestFrame: video.request, requestRetirement: animation.request,
    sampleFrame: () => fallback as ImageData,
    createReadback: () => { const reader = new Reader(); readers.push(reader); return reader },
    onTurnObserved: id => { seen.push(id); onObserved?.(id) }, onPlaybackEnded: id => ended.push(id),
    onTurnChanged: id => changed.push(id),
    logger: { log: (line: string) => logs.push(line), error: () => undefined } as any })
  playback.start()
  return { video, animation, readers, seen, ended, logs, changed, playback, setFallback: (image: StripePixels) => { fallback = image } }
}

test('last submitted frame retires on animation without a future video callback', () => {
  const f = fixture()
  f.video.emit(10, { rtpTimestamp: 20 })
  f.animation.emit()
  expect(f.seen).toEqual([])
  f.readers[0].ready = true
  f.animation.emit()
  expect(f.seen).toEqual(['A0'])
  f.playback.stop()
})

test('two busy slots synchronously retire oldest and retain incoming new turn', () => {
  const f = fixture(), r = f.readers[0]
  f.video.emit()
  r.image = pixels('B1'); f.video.emit()
  r.image = pixels('C2'); f.video.emit()
  expect(f.seen).toEqual(['A0'])
  r.ready = true; f.animation.emit()
  expect(f.seen).toEqual(['A0', 'B1', 'C2'])
  expect(f.ended).toEqual(['A0', 'B1'])
  expect(f.logs.some(line => line.startsWith('avatar_readback_saturation count=1 '))).toBe(true)
  f.playback.stop()
})

test('targeted accepted end preserves pending new turns and rejects retired evidence', () => {
  const f = fixture(), r = f.readers[0]
  f.video.emit()
  r.image = pixels('B1'); f.video.emit()
  f.playback.notifyMediaEnded('A0', true)
  r.ready = true; f.animation.emit()
  expect(f.ended).toEqual(['A0'])
  expect(f.seen).toEqual(['B1'])
  r.image = pixels('A0'); f.video.emit(); f.animation.emit()
  r.image = pixels('C2'); f.video.emit(); f.animation.emit()
  expect(f.seen).toEqual(['B1', 'C2'])
  expect(f.ended).toEqual(['A0', 'B1'])
  f.playback.stop()
})

test('untargeted end retires observed current only, not an unknown pending turn', () => {
  const f = fixture(), r = f.readers[0]
  f.video.emit(); f.playback.notifyMediaEnded()
  r.ready = true; f.animation.emit()
  expect(f.seen).toEqual(['A0'])
  r.ready = false; r.image = pixels('B1'); f.video.emit()
  f.playback.notifyMediaEnded()
  r.ready = true; f.animation.emit()
  expect(f.ended).toEqual(['A0'])
  expect(f.seen).toEqual(['A0', 'B1'])
  f.playback.stop()
})

test('loss discards old backend samples but retains retirement across Canvas2D fallback', () => {
  const f = fixture(), r = f.readers[0]
  f.video.emit(); r.ready = true; f.animation.emit()
  f.playback.notifyMediaEnded('A0')
  r.ready = false; r.image = pixels('B1'); f.video.emit()
  r.lost = true; f.animation.emit()
  f.setFallback(pixels('A0')); f.video.emit()
  f.setFallback(pixels('C2')); f.video.emit()
  expect(f.seen).toEqual(['A0', 'C2'])
  expect(f.ended).toEqual(['A0'])
  f.playback.stop()
})

test('restart fences queued animation and video callbacks from the old generation', () => {
  const f = fixture()
  f.video.emit(); f.playback.stop(); f.playback.start()
  const r = f.readers[1]; r.image = pixels('B1'); r.ready = true
  f.video.late(1)
  f.animation.late(0)
  expect(f.seen).toEqual([])
  f.video.emit(); f.animation.emit()
  expect(f.seen).toEqual(['B1'])
  f.playback.stop()
})

test('submitted metadata is immutable and pending dimensions survive resize', async () => {
  const f = fixture(), r = f.readers[0]
  const metadata = { rtpTimestamp: 31, presentationTime: 20 }
  f.video.emit(40, metadata)
  metadata.rtpTimestamp = 99; metadata.presentationTime = 90
  r.image = pixels('B1', 128); f.video.emit(50, metadata)
  r.ready = true; f.animation.emit(); await Promise.resolve()
  expect(f.seen).toEqual(['A0', 'B1'])
  const lines = f.logs.filter(line => line.startsWith('avatar_turn_observed '))
  const first = JSON.parse(lines[0].split(' frame_timing=')[1].split(' observation_timing=')[0])
  expect(first.rtp_timestamp).toBe(31)
  expect(first.presentation_time_ms).toBe(20)
  expect(first.callback_now_ms).toBe(40)
  f.playback.stop()
})

test('later-ready sample cannot overtake the oldest unready sample', () => {
  const f = fixture(), r = f.readers[0]
  f.video.emit()
  r.image = pixels('B1'); f.video.emit()
  r.readySequences.add(2); f.animation.emit()
  expect(f.seen).toEqual([])
  r.readySequences.add(1); f.animation.emit()
  expect(f.seen).toEqual(['A0', 'B1'])
  expect(f.ended).toEqual(['A0'])
  f.playback.stop()
})

test.each(['saturation', 'batch'])('listener restart during %s fences remaining/prepared samples and old hooks', async mode => {
  let restarted = false
  let f: ReturnType<typeof fixture>
  f = fixture(id => {
    if (id === 'A0' && !restarted) {
      restarted = true
      f.playback.stop(); f.playback.start()
    }
  })
  const old = f.readers[0]
  f.video.emit(); old.image = pixels('B1'); f.video.emit()
  if (mode === 'saturation') { old.image = pixels('C2'); f.video.emit() }
  else { old.ready = true; f.animation.emit() }
  await Promise.resolve()
  expect(f.seen).toEqual(['A0'])
  expect(f.changed).toEqual([])
  // An already-queued old scheduling callback cannot consume new-generation work.
  const current = f.readers[1]; current.image = pixels('D3'); current.ready = true
  f.animation.late(0)
  f.video.emit(); f.animation.emit(); await Promise.resolve()
  expect(f.seen).toEqual(['A0', 'D3'])
  expect(f.changed).toEqual(['D3'])
  expect(f.ended).toEqual([])
  f.playback.stop()
})

test('two-ready-sample diagnostics separate CPU decode from batching/listener elapsed time', () => {
  let clock = 100
  const now = jest.spyOn(performance, 'now').mockImplementation(() => clock++)
  let f: ReturnType<typeof fixture> | undefined
  try {
    f = fixture(() => { clock += 100 })
    const r = f.readers[0]
    f.video.emit(); r.image = pixels('B1'); f.video.emit()
    r.ready = true; f.animation.emit()
    const lines = f.logs.filter(line => line.startsWith('avatar_turn_observed '))
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      const decode = JSON.parse(line.split(' readback_timing=')[1])
      const elapsed = JSON.parse(line.split(' observation_timing=')[1].split(' readback_timing=')[0])
      expect(decode.decode_end_ms - decode.decode_start_ms).toBe(1)
      expect(elapsed.sampling_to_decoding_ms).toBeGreaterThan(1)
      expect(decode.decode_start_ms).toBeGreaterThan(decode.copy_end_ms)
    }
    expect(f.seen).toEqual(['A0', 'B1'])
  } finally { f?.playback.stop(); now.mockRestore() }
})

test('startup capability failure retains synchronous fallback API', () => {
  const video = scheduler<() => void>(), seen: string[] = []
  const playback = createAvatarPlayback({ requestFrame: video.request, requestRetirement: () => () => undefined,
    createReadback: () => null, sampleFrame: () => pixels('A0') as ImageData,
    onTurnObserved: id => seen.push(id), onPlaybackEnded: () => undefined })
  playback.start(); video.emit()
  expect(seen).toEqual(['A0'])
  playback.stop()
})
