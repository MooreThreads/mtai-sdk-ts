import type { TextureIdentity, TextureMessage } from './mainTexture'
import type { AttachmentKey } from '../voice/localMediaProtocol'

export interface ImportedVideo { getVideoFrame(): VideoFrame, release(): void }
export interface FrameCover { submit(frame: VideoFrame, rowOrigin: number): void }
export interface ReceiverEvents { submitted(identity: TextureIdentity): void, failed(error: Error): void }
const errorOf = (value: unknown) => value instanceof Error ? value : new Error(String(value))

/** Electron delivers each transfer on the renderer loop. VideoFrame.close and
 * the native import release have no application callbacks: arbitrary recursive
 * delivery/retry through substituted release methods is not a supported API.
 * Keep genuine failure custody and application-observer close fencing. */
export class TextureReceiver {
  private readonly target: AttachmentKey
  private sequence = 0n
  private active = false
  private closed = false
  private healthy = true
  private uncertain?: { imported: ImportedVideo, frame?: VideoFrame, error: Error }
  private pendingClose?: { promise: Promise<void>, resolve(): void, reject(error: Error): void }

  constructor(target: AttachmentKey, private allocation: bigint,
    private width: number, private height: number, private cover: FrameCover, private events: ReceiverEvents) {
    this.target = Object.freeze({ ...target })
  }

  receive(imported: ImportedVideo, message: TextureMessage): void {
    if (this.uncertain) {
      // An earlier uncertain native release already fenced this attachment.
      // Dispose the newly transferred import but keep the original custody.
      try { imported.release() } catch { /* attachment remains failed */ }
      return
    }
    this.active = true
    let frame: VideoFrame | undefined, error: Error | undefined
    try {
      const id = message.identity
      if (this.closed || !this.healthy || id.sessionId !== this.target.sessionId || id.generation !== this.target.generation
        || id.attachment !== this.target.attachment || id.allocation !== this.allocation
        || id.sequence !== this.sequence + 1n || ![1, 2].includes(message.rowOrigin)) throw new Error('unmatched texture receive')
      frame = imported.getVideoFrame()
      if (frame.displayWidth !== this.width || frame.displayHeight !== this.height) throw new Error('unexpected texture dimensions')
      this.cover.submit(frame, message.rowOrigin)
    } catch (caught) { error = errorOf(caught); this.fail(error) }
    try {
      if (frame) { frame.close(); frame = undefined }
      imported.release()
    } catch (caught) {
      error ??= errorOf(caught)
      // No proof that retrying a partially executed Electron release is safe.
      // Retain uncertain ownership and reject close; never certify retirement.
      this.uncertain = { imported, frame, error }; this.fail(error)
    }
    if (!error && this.healthy && !this.closed) {
      this.sequence = message.identity.sequence
      try { this.events.submitted(Object.freeze({ ...message.identity })) }
      catch (caught) { error = errorOf(caught); this.fail(error) }
    }
    this.active = false
    if (this.pendingClose) {
      if (this.uncertain) this.pendingClose.reject(this.uncertain.error)
      else this.pendingClose.resolve()
    }
  }

  close(): Promise<void> {
    this.closed = true; this.healthy = false
    if (this.pendingClose) return this.pendingClose.promise
    let resolve!: () => void, reject!: (error: Error) => void
    const promise = new Promise<void>((a, b) => { resolve = a; reject = b })
    this.pendingClose = { promise, resolve, reject }
    if (!this.active) {
      if (this.uncertain) reject(this.uncertain.error)
      else resolve()
    }
    return promise
  }
  private fail(error: Error) {
    if (!this.healthy) return
    this.healthy = false
    try { this.events.failed(error) } catch { /* failed observer never submits */ }
  }
}
