import type { TextureIdentity, TextureMessage } from './mainTexture'
import type { AttachmentKey } from '../voice/localMediaProtocol'

export interface ImportedVideo { getVideoFrame(): VideoFrame, release(): void }
export interface FrameCover { submit(frame: VideoFrame, rowOrigin: number): void }
export interface ReceiverEvents { submitted(identity: TextureIdentity): void, failed(error: Error): void }
type OwnedVideo = { imported: ImportedVideo, frame?: VideoFrame }
const errorOf = (value: unknown) => value instanceof Error ? value : new Error(String(value))

/** Attachment-scoped receiver; the independent cover may outlive it for the
 * same avatar. Main stamps submission receipt after authenticating sender. */
export class TextureReceiver {
  private readonly target: AttachmentKey
  private sequence = 0n
  private active = false
  private closed = false
  private healthy = true
  private owners = new Set<OwnedVideo>()
  private operationError?: Error
  private pendingClose?: { promise: Promise<void>, resolve(): void, reject(error: Error): void }

  constructor(target: AttachmentKey, private allocation: bigint,
    private width: number, private height: number, private cover: FrameCover, private events: ReceiverEvents) {
    this.target = Object.freeze({ ...target })
  }

  receive(imported: ImportedVideo, message: TextureMessage): void {
    const owner: OwnedVideo = { imported }; this.owners.add(owner)
    if (this.active) {
      this.fail(new Error('overlapping texture receive'))
      try { this.retire(owner) } catch (error) { this.operationError ??= errorOf(error) }
      return
    }
    this.active = true; this.operationError = undefined
    let error: Error | undefined
    try {
      const id = message.identity
      if (this.closed || !this.healthy || id.sessionId !== this.target.sessionId || id.generation !== this.target.generation
        || id.attachment !== this.target.attachment || id.allocation !== this.allocation
        || id.sequence !== this.sequence + 1n || ![1, 2].includes(message.rowOrigin)) throw new Error('unmatched texture receive')
      owner.frame = imported.getVideoFrame()
      if (owner.frame.displayWidth !== this.width || owner.frame.displayHeight !== this.height) throw new Error('unexpected texture dimensions')
      this.cover.submit(owner.frame, message.rowOrigin)
    } catch (caught) { error = errorOf(caught); this.fail(error) }
    // One retirement attempt per receive; failures retain the owner until a
    // subsequent explicit close. Failure is fenced before cleanup callbacks.
    try { this.retire(owner) } catch (caught) { error ??= errorOf(caught); this.fail(errorOf(caught)) }
    if (!error && this.healthy && !this.closed) {
      this.sequence = message.identity.sequence
      try { this.events.submitted(Object.freeze({ ...message.identity })) }
      catch (caught) { error = errorOf(caught); this.fail(error) }
    }
    this.operationError ??= error
    this.active = false
    if (this.pendingClose) this.completeClose(this.operationError)
  }

  close(): Promise<void> {
    this.closed = true; this.healthy = false
    if (this.pendingClose) return this.pendingClose.promise
    let resolve!: () => void, reject!: (error: Error) => void
    const promise = new Promise<void>((a, b) => { resolve = a; reject = b })
    const attempt = { promise, resolve, reject }
    this.pendingClose = attempt
    // Register before any cleanup can expose this promise to a reentrant
    // waiter. Its subsequent explicit retry must see the settled attempt gone.
    void promise.then(() => { if (this.pendingClose === attempt) this.pendingClose = undefined },
      () => { if (this.pendingClose === attempt) this.pendingClose = undefined })
    if (!this.active) this.completeClose()
    return promise
  }
  private completeClose(error?: Error) {
    const attempt = this.pendingClose!
    if (!error) {
      this.active = true; this.operationError = undefined
      try { this.retireAll() } catch (caught) { error = errorOf(caught) }
      error ??= this.operationError; this.active = false
    }
    if (error) attempt.reject(error); else attempt.resolve()
  }
  private retire(owner: OwnedVideo) {
    if (owner.frame) { owner.frame.close(); owner.frame = undefined }
    owner.imported.release(); this.owners.delete(owner)
  }
  private retireAll() {
    let error: Error | undefined
    for (const owner of [...this.owners]) { try { this.retire(owner) } catch (caught) { error ??= errorOf(caught) } }
    if (error) throw error
  }
  private fail(error: Error) {
    if (!this.healthy) return
    this.healthy = false
    try { this.events.failed(error) } catch { /* failed observer never submits */ }
  }
}
