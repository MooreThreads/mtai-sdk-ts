import { ABGR8888, type AttachmentKey, type Layout, type LocalMediaRecord,
  LocalMediaProtocolError, type MediaFrame } from './localMediaProtocol'

export type ResolvedOutputState = Readonly<{ turnId: string | null, audioActive: boolean }>
export type ResolvedMediaFrame = Readonly<{
  target: AttachmentKey, frame: Readonly<MediaFrame>, state: ResolvedOutputState,
}>
const sameTarget = (a: AttachmentKey, b: AttachmentKey) => a.sessionId === b.sessionId
  && a.generation === b.generation && a.attachment === b.attachment
const fail = (message: string): never => { throw new LocalMediaProtocolError(message) }

/** Resolves ordered output metadata; it does NOT report playback or authorize
 * source reuse. Native B pacing, PCM acceptance and healthy texture submission
 * must precede the later frameApplied observation. No tracker is called here.
 */
export class LocalMediaState {
  private target: AttachmentKey
  private layout?: Readonly<Layout>
  private isAttached = false
  private ended = false
  private sequence = 0n
  private samples = 0n
  private lastStateFrame = 0n
  private pendingStates = new Map<bigint, ResolvedOutputState>()
  private state?: ResolvedOutputState

  constructor(target: AttachmentKey) { this.target = Object.freeze({ ...target }) }
  get attached() { return this.isAttached && !this.ended }

  accept(record: LocalMediaRecord): ResolvedMediaFrame | null {
    if (!sameTarget(record.target, this.target)) return null
    if (this.ended) return fail('local media attachment has ended')
    switch (record.kind) {
      case 'layout': {
        if (this.layout) return fail('attachment already has a layout')
        if (record.allocation === 0n || record.width === 0 || record.height === 0
            || record.sampleRate === 0 || record.channels === 0 || record.sampleFormat !== 1
            || record.fourcc !== ABGR8888 || record.colorSpace !== 1
            || (record.rowOrigin !== 1 && record.rowOrigin !== 2)) return fail('unsupported media layout')
        const rowBytes = BigInt(record.width) * 4n
        if (record.stride < rowBytes || record.offset + BigInt(record.height - 1) * record.stride + rowBytes > record.extent) {
          return fail('image does not fit allocation layout')
        }
        this.layout = Object.freeze({ ...record })
        return null
      }
      case 'attached':
        if (!this.layout || this.isAttached || record.allocation !== this.layout.allocation) return fail('unmatched attachment acknowledgement')
        this.isAttached = true
        return null
      case 'state': {
        if (!this.isAttached) return fail('state before attachment')
        if (record.effectiveFrame <= this.sequence || record.effectiveFrame <= this.lastStateFrame
            || (this.lastStateFrame === 0n ? !record.snapshot || record.effectiveFrame !== 1n : record.snapshot)) {
          return fail('invalid effective output state')
        }
        this.pendingStates.set(record.effectiveFrame, Object.freeze({ turnId: record.turnId, audioActive: record.audioActive }))
        this.lastStateFrame = record.effectiveFrame
        return null
      }
      case 'frame': {
        if (!this.layout || !this.isAttached || record.allocation !== this.layout.allocation) return fail('frame before matching attachment')
        if (record.sequence !== this.sequence + 1n || record.sampleStart !== this.samples) return fail('noncontiguous publication or sample identity')
        if (BigInt(record.pcm.byteLength) !== record.sampleCount * BigInt(this.layout.channels) * 2n) return fail('PCM count does not match accepted format')
        const state = this.pendingStates.get(record.sequence) ?? this.state
        if (!state) return fail('frame has no initial output state')
        this.sequence = record.sequence
        this.samples += record.sampleCount
        this.pendingStates.delete(record.sequence)
        this.state = state
        return Object.freeze({ target: this.target, state,
          frame: Object.freeze({ sequence: record.sequence, allocation: record.allocation,
            rendererFrame: record.rendererFrame, producedNs: record.producedNs,
            sampleStart: record.sampleStart, sampleCount: record.sampleCount, pcm: new Uint8Array(record.pcm) }) })
      }
      case 'eos':
        if (!this.isAttached || record.lastSequence !== this.sequence || record.totalSamples !== this.samples) return fail('unmatched output EOS')
        this.ended = true
        this.pendingStates.clear()
        return null
      case 'detach': case 'failure':
        this.ended = true
        this.pendingStates.clear()
        return null
      default:
        return fail('record requires the native control owner')
    }
  }
}
