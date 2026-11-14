import type { AvatarAttachment, AvatarMediaEvent } from '../voice/avatarMediaHost'
import { decodeLocalMedia, encodeLocalMedia, type AttachmentKey, type Layout } from '../voice/localMediaProtocol'
import { TextureOutput, type SharedTextures, type TextureIdentity } from './mainTexture'

export interface AllocationLease { readonly fd: number, close(): void }
export interface NativeConnection {
  retainAllocation(): AllocationLease
  acceptLayout(allocation: bigint): void
  sendControl(wire: Uint8Array): void
  close(): Promise<void>
}
export type ConnectionEvent = { type: 'layout', wire: Uint8Array, fd: number }
  | { type: 'attached' | 'eos' }
  | { type: 'eligible', frame: Uint8Array, state: Uint8Array, originNs: bigint, revision: bigint }
  | { type: 'failed', message: string }
export interface NativePlayback {
  submitEligible(frame: Uint8Array, state: Uint8Array): void
  stop(session: string, generation: string, attachment: string, turn: string): Promise<void>
  end(): void
  close(): Promise<void>
}
export interface AvatarNative {
  createConnection(path: string, attach: Uint8Array, callback: (event: ConnectionEvent) => void): NativeConnection
  createPlayback(layout: Uint8Array, callback: (event: { type: string, message?: string }) => void): NativePlayback
  monotonicNs(): bigint
}
export interface TextureDestination {
  readonly frame: unknown
  /** Establish the actual receiver/context before the import acceptance probe. */
  prepare(target: AttachmentKey, layout: Layout): Promise<void>
  accepted(target: AttachmentKey): Promise<void>
  retire(target: AttachmentKey): Promise<void>
}
const buffer = (value: Uint8Array) => Buffer.from(value)
const errorOf = (error: unknown) => error instanceof Error ? error : new Error(String(error))
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}

/** One canonical attachment owns readiness, paired dispatch and retirement.
 * Native connection is the sole resolver/B clock. No rendering or device time
 * is inferred from STATE, EOS, PCM completion, or reference release alone. */
export class AttachmentRuntime {
  private target: AttachmentKey
  private connection?: NativeConnection
  private playback?: NativePlayback
  private allocation?: AllocationLease
  private texture?: TextureOutput
  private ready = deferred()
  private preparation: Promise<void> = Promise.resolve()
  private closing = false
  private closeAttempt?: Promise<void>
  private preparationImport?: ReturnType<SharedTextures['importSharedTexture']>
  private audioAcceptance?: ReturnType<typeof deferred>
  private preparationReferences?: ReturnType<typeof deferred>

  constructor(readonly attachment: AvatarAttachment, private socketPath: string,
    private native: AvatarNative, private textures: SharedTextures, private destination: TextureDestination,
    private emit: (event: AvatarMediaEvent) => void) {
    this.target = Object.freeze({ sessionId: attachment.dh2dSessionId, generation: attachment.generation, attachment: attachment.attachment })
  }

  attach(): Promise<void> {
    if (this.connection || this.closing) return Promise.reject(new Error('attachment already started or retired'))
    try {
      this.connection = this.native.createConnection(this.socketPath, buffer(encodeLocalMedia({ kind: 'attach', target: this.target })), event => this.receive(event))
    } catch (error) { this.fail(errorOf(error)) }
    return this.ready.promise
  }

  submitted(identity: TextureIdentity, ok: boolean): void {
    if (!this.closing) this.texture?.submitted(identity, ok, this.native.monotonicNs())
  }
  async stop(turn?: string): Promise<void> {
    if (this.closing) return
    // Missing identity is normalized/captured by the portable conversation.
    // Never turn a scoped stop into an attachment-global flush.
    if (turn) await this.playback?.stop(this.target.sessionId, this.target.generation, this.target.attachment, turn)
  }
  close(): Promise<void> {
    if (this.closeAttempt) return this.closeAttempt
    this.closing = true; this.audioAcceptance?.reject(new Error('attachment retired')); this.ready.reject(new Error('attachment retired'))
    const attempt = this.retire(); this.closeAttempt = attempt
    void attempt.then(() => { if (this.closeAttempt === attempt) this.closeAttempt = undefined },
      () => { if (this.closeAttempt === attempt) this.closeAttempt = undefined })
    return attempt
  }

  private receive(event: ConnectionEvent) {
    if (this.closing) return
    try {
      switch (event.type) {
        case 'layout':
          this.allocation = this.connection!.retainAllocation()
          this.preparation = this.prepare(event.wire)
          void this.preparation.catch(error => this.fail(errorOf(error)))
          break
        case 'attached': this.ready.resolve(); break
        case 'eligible': {
          const frame = decodeLocalMedia(event.frame), state = decodeLocalMedia(event.state)
          if (frame.kind !== 'frame' || state.kind !== 'state' || state.effectiveFrame !== frame.sequence || !this.texture || !this.playback) throw new Error('eligible output without prepared attachment')
          // One native B callback dispatches both. No JS scheduling gate.
          this.playback.submitEligible(buffer(event.frame), buffer(event.state))
          void this.texture.publish(frame, { turnId: state.turnId, audioActive: state.audioActive },
            { originNs: event.originNs, revision: event.revision }).catch(error => this.fail(errorOf(error)))
          break
        }
        case 'eos': this.playback?.end(); break
        case 'failed': this.fail(new Error(event.message)); break
      }
    } catch (error) { this.fail(errorOf(error)) }
  }

  private async prepare(wire: Uint8Array) {
    const layout = decodeLocalMedia(wire)
    if (layout.kind !== 'layout') throw new Error('LAYOUT required')
    const audio = deferred(); this.audioAcceptance = audio
    // Native construction can throw before Promise.all installs its handlers.
    // Observe cancellation/failure now; preparation still reports the original
    // factory error, and successful construction joins audio acceptance below.
    void audio.promise.catch(() => {})
    this.playback = this.native.createPlayback(buffer(wire), event => {
      if (event.type === 'audioReady') audio.resolve()
      if (event.type === 'failed') { const error = new Error(event.message ?? 'avatar audio failed'); audio.reject(error); this.fail(error) }
    })
    // Install both waits before awaiting either, avoiding an unhandled audio
    // failure while the receiver's actual graphics preparation is in progress.
    await Promise.all([audio.promise, Promise.resolve().then(() => {
      if (this.closing) throw new Error('attachment retired')
      return this.destination.prepare(this.target, layout)
    })])
    if (this.closing) return
    // An import-only bootstrap validates the real exported allocation/receiver
    // independently of FRAME1. It neither copies unproduced pixels nor anchors
    // B, produces a turn observation, or authorizes REUSE_ACK.
    const references = deferred(); this.preparationReferences = references
    const output = new TextureOutput(this.target, layout, this.allocation!.fd, this.destination.frame, this.textures, {
      applied: value => this.emit({ type: 'frameApplied', generation: this.target.generation, sequence: value.identity.sequence,
        turnId: value.state.turnId ?? undefined, audioActive: value.state.audioActive }),
      reuse: record => this.connection!.sendControl(buffer(encodeLocalMedia(record))),
      failed: error => this.fail(error),
    })
    this.texture = output
    // TextureOutput validates Electron representation. Bootstrap uses the same
    // exact layout; rowOrigin remains explicit rather than relabeling pixels.
    this.preparationImport = undefined
    try { this.preparationImport = this.textures.importSharedTexture({ textureInfo: {
      pixelFormat: 'rgba', codedSize: { width: layout.width, height: layout.height },
      visibleRect: { x: 0, y: 0, width: layout.width, height: layout.height },
      colorSpace: { primaries: 'bt709', transfer: 'srgb', matrix: 'rgb', range: 'full' },
      handle: { nativePixmap: { planes: [{ fd: this.allocation!.fd, stride: Number(layout.stride), offset: Number(layout.offset), size: Number(layout.extent) }],
        modifier: layout.modifier.toString(), supportsZeroCopyWebGpuImport: false } },
    }, allReferencesReleased: () => references.resolve() }) }
    catch (error) { references.resolve(); throw error }
    const accepted = this.destination.accepted(this.target)
    try {
      const imported = this.preparationImport
      const sent = Promise.resolve().then(() => this.textures.sendSharedTexture({ frame: this.destination.frame, importedSharedTexture: imported },
        { identity: { ...this.target, allocation: layout.allocation, sequence: 0n }, rowOrigin: layout.rowOrigin }))
      try { await Promise.all([sent, accepted]) }
      finally { await Promise.allSettled([sent]) }
    }
    finally { this.preparationImport.release(); this.preparationImport = undefined }
    await references.promise
    if (!this.closing) this.connection!.acceptLayout(layout.allocation)
  }

  private fail(error: Error) {
    if (this.closing) return
    this.closing = true; this.audioAcceptance?.reject(error); this.ready.reject(error)
    try { this.emit({ type: 'failed', generation: this.target.generation, error }) } finally {
      // Failure starts one owned cleanup attempt. Rejection is reported, not
      // converted into a successful close or retried automatically.
      void this.close().catch(() => {})
    }
  }
  private async retire() {
    // Cancel audio immediately, including pending format negotiation. GPU
    // preparation/reference work remains joined independently of socket close.
    const results = Promise.allSettled([this.playback?.close(), this.connection?.close()])
    let failure: unknown
    try { await this.destination.retire(this.target) } catch (error) { failure = error }
    try { await this.preparation } catch { /* original preparation failure reported */ }
    try { if (this.preparationImport) { this.preparationImport.release(); this.preparationImport = undefined } } catch (error) { failure ??= error }
    if (!this.preparationImport) await this.preparationReferences?.promise
    try { await this.texture?.close() } catch (error) { failure ??= error }
    for (const result of await results) if (result.status === 'rejected') failure ??= result.reason
    if (failure) throw failure
    this.allocation?.close(); this.allocation = undefined
  }
}
