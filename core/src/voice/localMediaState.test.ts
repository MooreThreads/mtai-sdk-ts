import { LocalMediaState } from './localMediaState'
import { ABGR8888, decodeLocalMedia, encodeLocalMedia, LocalMediaProtocolError,
  type AttachmentKey, type LocalMediaRecord } from './localMediaProtocol'

const target: AttachmentKey = { sessionId: 'canonical', generation: 'generation', attachment: 'attachment' }
const layout = (): LocalMediaRecord & { kind: 'layout' } => ({ kind: 'layout', target, allocation: 1n,
  width: 3, height: 2, fourcc: ABGR8888, stride: 16n, offset: 0n, modifier: 0n, extent: 32n,
  rowOrigin: 1, colorSpace: 1, sampleRate: 22050, channels: 1, sampleFormat: 1 })
const state = (effectiveFrame = 1n, turnId: string | null = 'A0', snapshot = true): LocalMediaRecord & { kind: 'state' } => ({
  kind: 'state', target, effectiveFrame, turnId, snapshot, audioActive: true,
})
const frame = (sequence = 1n, sampleStart = 0n): LocalMediaRecord & { kind: 'frame' } => ({
  kind: 'frame', target, sequence, allocation: 1n, rendererFrame: sequence + 99n, producedNs: 123n,
  sampleStart, sampleCount: 2n, pcm: Uint8Array.of(0, 128, 255, 127),
})
function ingest(owner: LocalMediaState, value: LocalMediaRecord) {
  // The state resolver consumes decoded records, as the native host will.
  return owner.accept(decodeLocalMedia(encodeLocalMedia(value)))
}
function attached(snapshot = true) {
  const owner = new LocalMediaState(target)
  ingest(owner, layout())
  ingest(owner, { kind: 'attached', target, allocation: 1n })
  if (snapshot) ingest(owner, state())
  return owner
}

test('layout is preparation; matching ATTACHED is a separate protocol milestone', () => {
  const owner = new LocalMediaState(target)
  expect(owner.attached).toBe(false)
  expect(ingest(owner, layout())).toBeNull()
  expect(owner.attached).toBe(false)
  expect(ingest(owner, { kind: 'attached', target, allocation: 1n })).toBeNull()
  expect(owner.attached).toBe(true)
  expect(ingest(owner, state())).toBeNull()
})

test('future state applies only at its frame, with immutable prior observations and repeated state', () => {
  const owner = attached()
  expect(ingest(owner, state(3n, 'B1', false))).toBeNull()
  const first = ingest(owner, frame())!
  const second = ingest(owner, frame(2n, 2n))!
  const third = ingest(owner, frame(3n, 4n))!
  expect(first.state.turnId).toBe('A0')
  expect(second.state.turnId).toBe('A0')
  expect(third.state.turnId).toBe('B1')
  expect(first.frame.rendererFrame).toBe(100n)
  expect(second.frame.sequence).toBe(2n)
})

test.each(['sessionId', 'generation', 'attachment'] as const)('stale %s cannot replace current evidence', key => {
  const owner = attached()
  expect(ingest(owner, { ...frame(99n), target: { ...target, [key]: 'old' } })).toBeNull()
  expect(ingest(owner, frame())!.state.turnId).toBe('A0')
})

test.each([
  ['publication-gap', { sequence: 3n }],
  ['sample-gap', { sampleStart: 3n }],
  ['wrong-allocation', { allocation: 2n }],
  ['pcm-count', { sampleCount: 3n }],
])('invalid current FRAME cannot create an observation: %s', (_, defect) => {
  const owner = attached(); ingest(owner, frame())
  expect(() => ingest(owner, { ...frame(2n, 2n), ...defect })).toThrow(LocalMediaProtocolError)
})

test('a missing initial STATE is not invented from FRAME/PCM', () => {
  expect(() => ingest(attached(false), frame())).toThrow(LocalMediaProtocolError)
})

test.each([
  ['not-initial-snapshot', state(1n, 'A0', false)],
  ['snapshot-not-frame-one', state(2n)],
])('invalid initial STATE is not playback: %s', (_, message) => {
  expect(() => ingest(attached(false), message as LocalMediaRecord)).toThrow(LocalMediaProtocolError)
})

test('stale/conflicting effective state cannot rewrite an accepted frame', () => {
  const owner = attached(); const first = ingest(owner, frame())!
  expect(() => ingest(owner, state(1n, 'B1', false))).toThrow(LocalMediaProtocolError)
  expect(first.state.turnId).toBe('A0')
})

test.each([
  ['width-zero', { width: 0 }], ['height-zero', { height: 0 }],
  ['short-stride', { stride: 11n }], ['short-extent', { extent: 27n }],
  ['pixel-format', { fourcc: 0 }], ['orientation', { rowOrigin: 0 }],
  ['color', { colorSpace: 0 }], ['audio-format', { sampleFormat: 0 }],
])('unusable layout cannot become attached: %s', (_, defect) => {
  const owner = new LocalMediaState(target)
  expect(() => ingest(owner, { ...layout(), ...defect })).toThrow(LocalMediaProtocolError)
  expect(owner.attached).toBe(false)
})

test('layout extent arithmetic remains lossless beyond JavaScript Number precision', () => {
  const owner = new LocalMediaState(target), offset = 9007199254740993n
  expect(ingest(owner, { ...layout(), offset, extent: offset + 28n })).toBeNull()
  expect(ingest(owner, { kind: 'attached', target, allocation: 1n })).toBeNull()
  expect(owner.attached).toBe(true) // metadata only, not a successful native import
})

test('zero-output EOS needs no invented turn/frame even with an unapplied snapshot', () => {
  const owner = attached()
  expect(ingest(owner, { kind: 'eos', target, lastSequence: 0n, totalSamples: 0n })).toBeNull()
  expect(owner.attached).toBe(false)
  expect(() => ingest(owner, frame())).toThrow(LocalMediaProtocolError)
})

test('EOS matches actual accepted frame/sample totals, never a per-turn completion certificate', () => {
  const owner = attached(); ingest(owner, frame())
  expect(() => ingest(owner, { kind: 'eos', target, lastSequence: 1n, totalSamples: 3n })).toThrow(LocalMediaProtocolError)
  expect(ingest(owner, { kind: 'eos', target, lastSequence: 1n, totalSamples: 2n })).toBeNull()
})

test('pending state and resolved PCM survive native input-object/buffer reuse', () => {
  const owner = attached(false), pending = state()
  owner.accept(pending)
  pending.turnId = 'B1'
  const input = frame()
  input.pcm = Buffer.from([0, 128, 255, 127])
  const resolved = owner.accept(input)!
  input.pcm.fill(0)
  expect(resolved.state.turnId).toBe('A0')
  expect(Array.from(resolved.frame.pcm)).toEqual([0, 128, 255, 127])
})

test('invalid output token/activity is preserved as data, not replaced with an idle successor', () => {
  const owner = attached(false)
  expect(ingest(owner, { ...state(), turnId: '??', audioActive: false })).toBeNull()
  expect(ingest(owner, frame())!.state).toEqual({ turnId: '??', audioActive: false })
})
