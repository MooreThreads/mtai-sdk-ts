import { events } from "../events";

export const DH2DPlaybackAudioStatusState = [
  "pending",
  "running",
  "unavailable",
  "failed",
] as const

export type DH2DPlaybackAudioStatus = {
  state: typeof DH2DPlaybackAudioStatusState[number]
  rms: number
  audioActive: boolean
  silentForMs: number
  connectionSeq: number
  activitySeq: number
}

export type DH2DPlayback = {
  readonly audioStatus: DH2DPlaybackAudioStatus
  readonly observeAudioStatus: (
    cb: (_: DH2DPlaybackAudioStatus) => void,
  ) => (() => void)
}

export type MutableDH2DPlayback = DH2DPlayback & {
  readonly setAudioStatus: (next: DH2DPlaybackAudioStatus) => void
  readonly resetAudioStatus: (connectionSeq: number) => void
  readonly markAudioStatusUnavailable: (connectionSeq: number) => void
}

function pendingAudioStatus(connectionSeq: number): DH2DPlaybackAudioStatus {
  return {
    state: "pending",
    rms: 0,
    audioActive: false,
    silentForMs: 0,
    connectionSeq,
    activitySeq: 0,
  }
}

function unavailableAudioStatus(connectionSeq: number): DH2DPlaybackAudioStatus {
  return {
    state: "unavailable",
    rms: 0,
    audioActive: false,
    silentForMs: 0,
    connectionSeq,
    activitySeq: 0,
  }
}

export function createDH2DPlayback(connectionSeq = 0): MutableDH2DPlayback {
  const evt = events<{ audioStatus: DH2DPlaybackAudioStatus }>()
  let audioStatus = pendingAudioStatus(connectionSeq)
  const publish = (next: DH2DPlaybackAudioStatus) => {
    if (
      audioStatus.state === next.state
      && audioStatus.rms === next.rms
      && audioStatus.audioActive === next.audioActive
      && audioStatus.silentForMs === next.silentForMs
      && audioStatus.connectionSeq === next.connectionSeq
      && audioStatus.activitySeq === next.activitySeq
    ) {
      return
    }
    audioStatus = next
    evt.emit("audioStatus", next)
  }

  return {
    get audioStatus() {
      return audioStatus
    },
    observeAudioStatus(cb) {
      return evt.on("audioStatus", cb)
    },
    setAudioStatus(next) {
      publish(next)
    },
    resetAudioStatus(nextConnectionSeq) {
      publish(pendingAudioStatus(nextConnectionSeq))
    },
    markAudioStatusUnavailable(nextConnectionSeq) {
      publish(unavailableAudioStatus(nextConnectionSeq))
    },
  }
}
