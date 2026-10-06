import { Logger } from "../types"

/**
 * Microphone capture for the voice-client protocol.
 *
 * `audioInput: true` captures the default device through
 * `navigator.mediaDevices.getUserMedia` (matching the legacy DH2D audio-input
 * behavior); a provided `MediaStream` is used as-is and is never stopped by
 * this module. Captured audio is delivered to `onPcm` as mono 16-bit
 * little-endian PCM linearly resampled to `VOICE_INPUT_SAMPLE_RATE`, ready to
 * follow an input `audio.chunk` control frame on the voice-client websocket.
 */

/** Input PCM sample rate delivered to the voice client. */
export const VOICE_INPUT_SAMPLE_RATE = 16000

const PROCESSOR_BUFFER_SIZE = 4096

export type VoiceMicrophoneOptions = {
  /** `true` captures the default device; a MediaStream is used as provided. */
  audioInput: boolean | MediaStream,
  logger?: Logger,
  /** Receives mono PCM16 little-endian batches at `VOICE_INPUT_SAMPLE_RATE`. */
  onPcm: (_: Uint8Array) => void,
}

export type VoiceMicrophone = {
  /** Resolves when capture is running; rejects when capture cannot start. */
  ready: Promise<void>,
  /** Stops capture and releases resources acquired by this microphone. */
  stop: () => void,
}

/**
 * Converts Float32 samples to mono little-endian PCM16, linearly resampling
 * `sampleRate` to `targetRate` when they differ.
 */
export function encodePcm16Mono(
  samples: Float32Array,
  sampleRate: number,
  targetRate: number = VOICE_INPUT_SAMPLE_RATE,
): Uint8Array {
  const ratio = targetRate / sampleRate
  const outputLength = samples.length <= 1 || ratio === 1
    ? samples.length
    : Math.floor((samples.length - 1) * ratio) + 1
  const bytes = new Uint8Array(outputLength * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < outputLength; i++) {
    const position = i / ratio
    const index = Math.floor(position)
    const next = Math.min(index + 1, samples.length - 1)
    const value = samples[index] + (samples[next] - samples[index]) * (position - index)
    view.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, value)) * 32767), true)
  }
  return bytes
}

export function createVoiceMicrophone(options: VoiceMicrophoneOptions): VoiceMicrophone {
  const { audioInput, logger, onPcm } = options
  let stopped = false
  let audioContext: AudioContext | undefined
  let acquiredStream: MediaStream | undefined

  function release() {
    if (audioContext) {
      const context = audioContext
      audioContext = undefined
      void context.close().catch(() => undefined)
    }
    if (acquiredStream) {
      const stream = acquiredStream
      acquiredStream = undefined
      stream.getAudioTracks().forEach(track => track.stop())
    }
  }

  function stop() {
    if (stopped) {
      return
    }
    stopped = true
    release()
  }

  const ready = (async () => {
    try {
      const AudioContextCtor = (globalThis as any).AudioContext
        ?? (globalThis as any).webkitAudioContext
      if (typeof AudioContextCtor !== 'function') {
        throw new Error('voice microphone input requires an AudioContext')
      }
      const stream = typeof audioInput === 'boolean'
        ? await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true }, video: false })
        : audioInput
      if (stopped) {
        if (typeof audioInput === 'boolean') {
          stream.getAudioTracks().forEach(track => track.stop())
        }
        return
      }
      if (typeof audioInput === 'boolean') {
        acquiredStream = stream
      }
      const context = new AudioContextCtor() as AudioContext
      audioContext = context
      const source = context.createMediaStreamSource(stream)
      const processor = context.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1)
      processor.onaudioprocess = event => {
        if (stopped) {
          return
        }
        onPcm(encodePcm16Mono(event.inputBuffer.getChannelData(0), context.sampleRate))
      }
      // A ScriptProcessorNode only runs while connected to a destination; a
      // zero-gain sink keeps the graph pumping without echoing the capture.
      const sink = context.createGain()
      sink.gain.value = 0
      source.connect(processor)
      processor.connect(sink)
      sink.connect(context.destination)
      void context.resume().catch(error => {
        logger?.error('failed to resume the voice microphone context', error)
      })
    } catch (error) {
      release()
      throw error
    }
  })()

  return { ready, stop }
}
