import { ABGR8888, type AttachmentKey, type Layout, type LocalMediaRecord, type MediaFrame } from '../voice/localMediaProtocol'
import type { ResolvedOutputState } from '../voice/localMediaState'

export type TextureIdentity = Readonly<AttachmentKey & { allocation: bigint, sequence: bigint }>
export type TexturePhase = Readonly<{ originNs: bigint, revision: bigint }>
export type TextureMessage = Readonly<{ identity: TextureIdentity, rowOrigin: number }>
export interface TextureImport { release(): void }
/** Structural subset of Electron 40 sharedTexture. This module neither loads
 * Electron nor installs IPC. The host must authenticate submitted()'s sender. */
export interface SharedTextures {
  importSharedTexture(options: {
    textureInfo: { pixelFormat: 'rgba', codedSize: { width: number, height: number },
      visibleRect: { x: number, y: number, width: number, height: number },
      colorSpace: { primaries: 'bt709', transfer: 'srgb', matrix: 'rgb', range: 'full' },
      handle: { nativePixmap: { planes: { fd: number, stride: number, offset: number, size: number }[],
        modifier: string, supportsZeroCopyWebGpuImport: false } } },
    allReferencesReleased(): void,
  }): TextureImport
  sendSharedTexture(options: { frame: unknown, importedSharedTexture: TextureImport }, message: TextureMessage): Promise<void>
}
export interface TextureEvents {
  applied(frame: Readonly<{ identity: TextureIdentity, state: ResolvedOutputState }>): void
  reuse(record: Extract<LocalMediaRecord, { kind: 'reuseAck' }>): void
  failed(error: Error): void
}
const same = (a: TextureIdentity, b: TextureIdentity) => a.sessionId === b.sessionId
  && a.generation === b.generation && a.attachment === b.attachment
  && a.allocation === b.allocation && a.sequence === b.sequence
const errorOf = (value: unknown) => value instanceof Error ? value : new Error(String(value))
const numeric = (value: bigint) => {
  const number = Number(value)
  if (value < 0n || !Number.isSafeInteger(number)) throw new Error('layout value is not representable by Electron')
  return number
}
function signal() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
type Publication = {
  identity: TextureIdentity, state: ResolvedOutputState, phase: TexturePhase,
  imported?: TextureImport, releaseFailure?: Error, sent: boolean, released: boolean, references: boolean,
  receipt?: bigint, applied: boolean, acked: boolean,
  transfer: ReturnType<typeof signal>, retirement: ReturnType<typeof signal>,
}

/** Owns main-process imports, NOT the allocation descriptor. Caller retains the
 * borrowed FD and joins close() before native connection retirement. Submission
 * is healthy renderer GPU-copy/draw work, never presentation or acoustics. */
export class TextureOutput {
  private readonly target: AttachmentKey
  private readonly layout: Readonly<Layout>
  private current?: Publication
  private lastSequence = 0n
  private healthy = true
  private closing = false
  private closeAttempt?: Promise<void>

  constructor(target: AttachmentKey, layout: Layout, private fd: number,
    private frame: unknown, private textures: SharedTextures, private events: TextureEvents) {
    if (!Number.isInteger(fd) || fd < 0 || layout.allocation <= 0n || layout.fourcc !== ABGR8888
      || layout.colorSpace !== 1 || ![1, 2].includes(layout.rowOrigin)
      || !Number.isInteger(layout.width) || layout.width <= 0 || layout.width > 0x7fffffff
      || !Number.isInteger(layout.height) || layout.height <= 0 || layout.height > 0x7fffffff
      || layout.stride > 0xffffffffn
      || layout.stride < BigInt(layout.width) * 4n
      || layout.offset + BigInt(layout.height - 1) * layout.stride + BigInt(layout.width) * 4n > layout.extent) {
      throw new Error('unsupported texture allocation')
    }
    for (const value of [layout.stride, layout.offset, layout.extent]) numeric(value)
    this.target = Object.freeze({ ...target }); this.layout = Object.freeze({ ...layout })
  }

  async publish(frame: MediaFrame, state: ResolvedOutputState, phase: TexturePhase): Promise<void> {
    if (!this.healthy || this.closing) throw new Error('texture output closed')
    if (this.current || frame.sequence !== this.lastSequence + 1n || frame.allocation !== this.layout.allocation) {
      const error = new Error('unmatched or overlapping texture publication'); this.fail(error); throw error
    }
    const identity = Object.freeze({ ...this.target, allocation: frame.allocation, sequence: frame.sequence })
    const publication: Publication = { identity, state: Object.freeze({ ...state }), phase: Object.freeze({ ...phase }),
      sent: false, released: false, references: false, applied: false, acked: false, transfer: signal(), retirement: signal() }
    this.current = publication; this.lastSequence = frame.sequence
    let failure: Error | undefined
    try {
      publication.imported = this.textures.importSharedTexture({ textureInfo: {
        pixelFormat: 'rgba', codedSize: { width: this.layout.width, height: this.layout.height },
        visibleRect: { x: 0, y: 0, width: this.layout.width, height: this.layout.height },
        colorSpace: { primaries: 'bt709', transfer: 'srgb', matrix: 'rgb', range: 'full' },
        handle: { nativePixmap: { planes: [{ fd: this.fd, stride: numeric(this.layout.stride),
          offset: numeric(this.layout.offset), size: numeric(this.layout.extent) }],
          modifier: this.layout.modifier.toString(), supportsZeroCopyWebGpuImport: false } },
      }, allReferencesReleased: () => {
        if (publication.references) { this.fail(new Error('duplicate all-reference release')); return }
        publication.references = true; publication.retirement.resolve(); this.progress(publication)
      } })
      await this.textures.sendSharedTexture({ frame: this.frame, importedSharedTexture: publication.imported },
        Object.freeze({ identity, rowOrigin: this.layout.rowOrigin }))
      publication.sent = true
    } catch (error) { failure = errorOf(error); this.fail(failure) }
    // Failed transfer is cleanup, not permission to reuse. Never release main's
    // import while send is still using it; close joins this same transfer.
    try {
      if (publication.imported) this.release(publication)
      else { publication.references = true; publication.retirement.resolve() }
    } catch (error) { failure ??= errorOf(error); this.fail(errorOf(error)) }
    publication.transfer.resolve()
    this.progress(publication)
    if (failure) throw failure
  }

  /** Called only by the authenticated current main-frame IPC receiver, stamped
   * with native CLOCK_MONOTONIC at receipt, not renderer/producer clocks. */
  submitted(identity: TextureIdentity, ok: boolean, receiptNs: bigint): void {
    if (!this.healthy || this.closing) return
    const publication = this.current
    if (!publication || !same(identity, publication.identity) || ok !== true
      || typeof receiptNs !== 'bigint' || receiptNs <= 0n || publication.receipt !== undefined) {
      this.fail(new Error('unmatched or unhealthy texture submission')); return
    }
    publication.receipt = receiptNs; this.progress(publication)
  }

  /** Fence first. Real import/reference retirement is still required; stopping
   * or releasing alone never produces applied/reuse. No timeout or retry loop. */
  close(): Promise<void> {
    if (this.closeAttempt) return this.closeAttempt
    this.closing = true; this.healthy = false
    const attempt = this.retire()
    this.closeAttempt = attempt
    void attempt.then(() => { if (this.closeAttempt === attempt) this.closeAttempt = undefined },
      () => { if (this.closeAttempt === attempt) this.closeAttempt = undefined })
    return attempt
  }

  private async retire(): Promise<void> {
    const publication = this.current
    if (!publication) return
    const retry = publication.releaseFailure
    await publication.transfer.promise
    if (publication.releaseFailure && !retry) throw publication.releaseFailure
    if (publication.imported && !publication.released) this.release(publication)
    await publication.retirement.promise
    if (this.current === publication) this.current = undefined
  }

  private release(publication: Publication) {
    try { publication.imported!.release(); publication.released = true; publication.releaseFailure = undefined }
    catch (error) { publication.releaseFailure = errorOf(error); throw error }
  }
  private fail(error: Error) {
    if (!this.healthy) return
    this.healthy = false
    try { this.events.failed(error) } catch { /* observer cannot authorize reuse */ }
  }
  private progress(publication: Publication) {
    if (!this.healthy || this.closing || this.current !== publication
      || !publication.sent || !publication.released || publication.receipt === undefined) return
    try {
      if (!publication.applied) {
        publication.applied = true
        this.events.applied(Object.freeze({ identity: publication.identity, state: publication.state }))
      }
      if (!this.healthy || this.closing || this.current !== publication || !publication.references || publication.acked) return
      publication.acked = true
      // Clear before callback: successful ACK can synchronously admit the next
      // publication. A throwing sender fails, never retries or fabricates ACK.
      this.current = undefined
      this.events.reuse({ kind: 'reuseAck', target: this.target, sequence: publication.identity.sequence,
        allocation: publication.identity.allocation, submissionReceiptNs: publication.receipt,
        phaseOriginNs: publication.phase.originNs, phaseRevision: publication.phase.revision,
        phaseEffectiveFrame: publication.identity.sequence })
    } catch (error) { this.fail(errorOf(error)) }
  }
}
