import { TextureOutput, type SharedTextures, type TextureIdentity, type TextureMessage, type TextureEvents } from './mainTexture'
import { ABGR8888, type Layout, type MediaFrame, type LocalMediaRecord } from '../voice/localMediaProtocol'
const target = { sessionId: 's', generation: 'g', attachment: 'a' }
const layout: Layout = { allocation: 7n, width: 4, height: 3, fourcc: ABGR8888, stride: 32n, offset: 16n,
  extent: 96n, modifier: 0n, rowOrigin: 1, colorSpace: 1, sampleRate: 16000, channels: 1, sampleFormat: 1 }
const state = { turnId: 'A1', audioActive: true }
const frame = (sequence = 1n): MediaFrame => ({ sequence, allocation: 7n, rendererFrame: 9007199254740993n,
  producedNs: 0n, sampleStart: 0n, sampleCount: 0n, pcm: new Uint8Array() })
const phase = { originNs: 9007199254740993n, revision: 2n }
const signal = () => { let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function fixture(overrides: Partial<TextureEvents> = {}, inputLayout = layout) {
  const transfers: ReturnType<typeof signal>[] = [], references: (() => void)[] = [], messages: TextureMessage[] = []
  const releases: jest.Mock[] = [], imports: Parameters<SharedTextures['importSharedTexture']>[0][] = []
  const applied: unknown[] = [], reuse: LocalMediaRecord[] = [], failures: Error[] = []
  const textures: SharedTextures = {
    importSharedTexture(options) { imports.push(options); references.push(options.allReferencesReleased)
      const release = jest.fn(); releases.push(release); return { release } },
    sendSharedTexture(_options, message) { messages.push(message); const transfer = signal(); transfers.push(transfer); return transfer.promise },
  }
  const output = new TextureOutput(target, inputLayout, 42, 'main-frame', textures, {
    applied: value => applied.push(value), reuse: value => reuse.push(value), failed: error => failures.push(error), ...overrides,
  })
  return { output, textures, imports, transfers, references, releases, messages, applied, reuse, failures }
}
const identity = (value: ReturnType<typeof fixture>, index = 0): TextureIdentity => value.messages[index].identity

it.each(['reference-first', 'submission-first', 'send-first'])('qualifies reuse only after all healthy witnesses: %s', async order => {
  const f = fixture(); const publication = f.output.publish(frame(), state, phase)
  expect(f.imports[0].textureInfo).toEqual({ pixelFormat: 'rgba', codedSize: { width: 4, height: 3 },
    visibleRect: { x: 0, y: 0, width: 4, height: 3 }, colorSpace: { primaries: 'bt709', transfer: 'srgb', matrix: 'rgb', range: 'full' },
    handle: { nativePixmap: { planes: [{ fd: 42, stride: 32, offset: 16, size: 96 }], modifier: '0', supportsZeroCopyWebGpuImport: false } } })
  if (order === 'reference-first') f.references[0]()
  if (order !== 'send-first') f.output.submitted(identity(f), true, 123n)
  expect(f.reuse).toHaveLength(0); f.transfers[0].resolve(); await publication
  if (order === 'send-first') { expect(f.applied).toHaveLength(0); f.output.submitted(identity(f), true, 123n) }
  expect(f.applied).toEqual([{ identity: identity(f), state }])
  if (order !== 'reference-first') { expect(f.reuse).toHaveLength(0); f.references[0]() }
  expect(f.releases[0]).toHaveBeenCalledTimes(1)
  expect(f.reuse).toEqual([{ kind: 'reuseAck', target, sequence: 1n, allocation: 7n, submissionReceiptNs: 123n,
    phaseOriginNs: phase.originNs, phaseRevision: 2n, phaseEffectiveFrame: 1n }])
  await f.output.close(); expect(f.failures).toHaveLength(0)
})

it('uses fresh imports and forwards row orientation without silently flipping pixels', async () => {
  const f = fixture({}, { ...layout, rowOrigin: 2 })
  for (const seq of [1n, 2n]) {
    const publication = f.output.publish(frame(seq), state, phase)
    expect(f.messages[f.messages.length - 1]?.rowOrigin).toBe(2)
    f.output.submitted(identity(f, Number(seq - 1n)), true, 100n + seq)
    f.transfers[Number(seq - 1n)].resolve(); await publication; f.references[Number(seq - 1n)]()
  }
  expect(f.imports).toHaveLength(2); expect(f.reuse).toHaveLength(2); await f.output.close()
})

it('close fences effects immediately and joins send, main release and real allrefs', async () => {
  const f = fixture(); const publication = f.output.publish(frame(), state, phase)
  let closed = false; const closing = f.output.close().then(() => { closed = true })
  f.output.submitted(identity(f), true, 123n); await Promise.resolve()
  expect(closed).toBe(false); expect(f.releases[0]).not.toHaveBeenCalled()
  f.transfers[0].resolve(); await publication; await Promise.resolve()
  expect(f.releases[0]).toHaveBeenCalledTimes(1); expect(closed).toBe(false)
  f.references[0](); await closing; expect(closed).toBe(true)
  expect(f.applied).toEqual([]); expect(f.reuse).toEqual([])
  await f.output.close()
})

it('failed transfer releases main but waits references and never acknowledges destruction', async () => {
  const f = fixture(); const publication = f.output.publish(frame(), state, phase)
  f.output.submitted(identity(f), true, 123n); f.transfers[0].reject(new Error('send failed'))
  await expect(publication).rejects.toThrow('send failed'); expect(f.releases[0]).toHaveBeenCalledTimes(1)
  expect(f.failures).toHaveLength(1); expect(f.applied).toEqual([]); expect(f.reuse).toEqual([])
  f.references[0](); await f.output.close()
})

it('import failure is resource-free retirement, not an ACK', async () => {
  const f = fixture(); f.textures.importSharedTexture = () => { throw new Error('bad import') }
  await expect(f.output.publish(frame(), state, phase)).rejects.toThrow('bad import')
  await f.output.close(); expect(f.reuse).toEqual([]); expect(f.failures).toHaveLength(1)
})

it('failed release retains the owner for an explicit joined close attempt', async () => {
  const f = fixture(); const publication = f.output.publish(frame(), state, phase)
  f.releases[0].mockImplementationOnce(() => { throw new Error('release failed') })
  f.output.submitted(identity(f), true, 123n); f.transfers[0].resolve()
  await expect(publication).rejects.toThrow('release failed'); expect(f.reuse).toEqual([])
  f.references[0](); await f.output.close(); expect(f.releases[0]).toHaveBeenCalledTimes(2)
  expect(f.applied).toEqual([])
})

it.each(['wrong-generation', 'wrong-allocation', 'wrong-sequence', 'unhealthy', 'duplicate'])('fails qualified submission violations: %s', async defect => {
  const f = fixture(); const publication = f.output.publish(frame(), state, phase)
  const id = { ...identity(f) }
  if (defect === 'wrong-generation') id.generation = 'replacement'
  if (defect === 'wrong-allocation') id.allocation = 9n
  if (defect === 'wrong-sequence') id.sequence = 2n
  f.output.submitted(id, defect !== 'unhealthy', 123n)
  if (defect === 'duplicate') f.output.submitted(id, true, 124n)
  f.transfers[0].resolve(); await publication; f.references[0](); await f.output.close()
  expect(f.failures).toHaveLength(1); expect(f.reuse).toEqual([]); expect(f.applied).toEqual([])
})

it('applied callback close reentry fences reuse while cleanup joins references', async () => {
  let closing!: Promise<void>; const f = fixture({ applied() { closing = f.output.close() } })
  const publication = f.output.publish(frame(), state, phase)
  f.output.submitted(identity(f), true, 123n); f.references[0](); f.transfers[0].resolve()
  await publication; await closing; expect(f.reuse).toEqual([])
})

it('throwing applied observer fails instead of acknowledging', async () => {
  const f = fixture({ applied() { throw new Error('observer') } })
  const publication = f.output.publish(frame(), state, phase)
  f.output.submitted(identity(f), true, 123n); f.references[0](); f.transfers[0].resolve(); await publication
  expect(f.failures[0].message).toBe('observer'); expect(f.reuse).toEqual([]); await f.output.close()
})

it('a close already waiting on transfer cannot automatically retry a later failed release', async () => {
  const f = fixture(); const publication = f.output.publish(frame(), state, phase)
  const closing = f.output.close()
  f.releases[0].mockImplementationOnce(() => { throw new Error('late release failure') })
  f.transfers[0].resolve()
  await expect(publication).rejects.toThrow('late release failure')
  await expect(closing).rejects.toThrow('late release failure')
  expect(f.releases[0]).toHaveBeenCalledTimes(1)
  f.references[0](); await f.output.close(); expect(f.releases[0]).toHaveBeenCalledTimes(2)
  expect(f.reuse).toEqual([])
})

it('overlapping closes share one retirement attempt and cannot retry its new failure', async () => {
  const f = fixture(); const publication = f.output.publish(frame(), state, phase)
  f.releases[0].mockImplementationOnce(() => { throw new Error('initial failure') })
    .mockImplementationOnce(() => { throw new Error('retry failure') })
  f.transfers[0].resolve(); await expect(publication).rejects.toThrow('initial failure')
  const first = f.output.close(), second = f.output.close()
  await expect(first).rejects.toThrow('retry failure'); await expect(second).rejects.toThrow('retry failure')
  expect(f.releases[0]).toHaveBeenCalledTimes(2)
  f.references[0](); await f.output.close(); expect(f.releases[0]).toHaveBeenCalledTimes(3)
  expect(f.applied).toEqual([]); expect(f.reuse).toEqual([])
})

it('a throwing reuse sender is not retried or mistaken for successful delivery', async () => {
  const reuse = jest.fn(() => { throw new Error('ACK send failed') }); const f = fixture({ reuse })
  const publication = f.output.publish(frame(), state, phase)
  f.output.submitted(identity(f), true, 123n); f.transfers[0].resolve(); await publication; f.references[0]()
  expect(reuse).toHaveBeenCalledTimes(1); expect(f.failures[0].message).toBe('ACK send failed')
  await f.output.close(); expect(reuse).toHaveBeenCalledTimes(1)
})

it('passes nonzero modifier losslessly as Electron decimal text', async () => {
  const f = fixture({}, { ...layout, modifier: 9007199254740993n })
  const publication = f.output.publish(frame(), state, phase)
  expect(f.imports[0].textureInfo.handle.nativePixmap.modifier).toBe('9007199254740993')
  f.transfers[0].resolve(); await publication; f.references[0](); await f.output.close()
})

it('accepts Electron integer representation boundaries without imposing GPU limits', () => {
  expect(() => fixture({}, { ...layout, width: 0x3fffffff, height: 1, stride: 0xffffffffn, offset: 0n, extent: 0xffffffffn })).not.toThrow()
  expect(() => fixture({}, { ...layout, height: 0x7fffffff, stride: 16n, offset: 0n, extent: 0x7fffffffn * 16n })).not.toThrow()
})

it.each([
  { width: 0x80000000, height: 1, stride: 0x200000000n, extent: 0x200000000n },
  { height: 0x80000000, stride: 16n, extent: 0x80000000n * 16n },
  { stride: 0x100000000n, extent: 0x100000000n * 3n },
])('rejects fields outside Electron destination integer ranges', changes => {
  expect(() => fixture({}, { ...layout, offset: 0n, ...changes })).toThrow('unsupported')
})

it('rejects Electron-unrepresentable layout fields rather than narrowing', () => {
  expect(() => fixture({}, { ...layout, extent: 9007199254740993n })).toThrow('representable')
  expect(() => fixture({}, { ...layout, offset: -1n })).toThrow()
})
