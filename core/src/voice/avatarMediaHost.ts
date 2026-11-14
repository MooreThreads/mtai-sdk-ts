/** Portable capability only: no Electron, native addon, React, FD or pixel API. */
export type AvatarStatus = 'loading' | 'ready' | 'failed'
export type AvatarAttachment = {
  conversationSessionId: string,
  dh2dSessionId: string,
  /** SDK-local presentation selection, never added to the client/native wire. */
  avatarId?: string,
  /** SDK-created attachment identity, echoed/fenced by the DH2D/native host. */
  generation: string,
  attachment: string,
}
export type AvatarMediaEvent =
  | {
    /** A healthy submitted playback frame, with its resolved immutable state.
     * Emitted for every frame, not only wire STATE changes: repeated valid turn
     * observations are needed by the adapter's pending sleep sequencing.
     * Socket STATE receipt alone must never emit this event.
     */
    type: 'frameApplied', generation: string, sequence: bigint,
    turnId?: string, audioActive: boolean,
  }
  | { type: 'failed', generation: string, error: Error }

export interface AvatarMediaHost {
  /** Resolves when native output can accept media, independently of visibility
   * and first submission. Frame events follow this acceptance. Repeated active
   * audio owners are forbidden; the caller joins retirement before replacement.
   */
  attach(target: AvatarAttachment): Promise<void>
  /** Cancels/joins affected owned media. detach also cancels pending attach.
   * Receipt construction is independent of remote-clear/device-drain proofs.
   */
  stop(request: { generation: string, turnId?: string, reason: 'interrupt' | 'clear' | 'detach' }): Promise<void>
  subscribe(listener: (event: AvatarMediaEvent) => void): () => void
  /** Fences and joins all owned work, including pending attachment; idempotent. */
  dispose(): Promise<void>
}
