import { DHConnectionEvents, DHConnectionEventTypes, DHInputMessage, EventSource, UnionEqual } from "../types";
import type { VoiceClientToolHandler } from "../voice/channelBinding";

/**
 * Represents a connection to the server.
 */
export type DH2DConnection = EventSource<DHConnectionEvents> & {
  /**
   * The unique identifier for the session.
   */
  readonly sessionId: string
  /**
   * The WebSocket connection to the server.
   */
  readonly ws: WebSocket
  /**
   * The WebRTC connection to the server.
   */
  readonly pc: RTCPeerConnection
  /**
   * The WebRTC connection to the server for audio.
   */
  readonly audioPc?: RTCPeerConnection
}
/**
 * Represents the HTML elements used for the player.
 */
export type DH2DPlayerElements = {
  /** Untransformed host for SDK-owned UI. */
  container?: HTMLElement
  /** Releases player presentation listeners. */
  dispose?: () => void
  /**
   * The video element used to display the video stream.
   */
  video: HTMLVideoElement
  /**
   * Optional canvas element used as a cover or overlay for the video.
   */
  cover?: HTMLCanvasElement
}
/**
 * Voice-client avatar mode: the SDK talks to the local voice client for
 * voice protocol traffic and exchanges the WebRTC offer directly with DH2D
 * using the canonical session id reported by `dh_2d_session_ready`.
 */
export type DH2DVoiceClientConfig = {
  /**
   * Base URL of the browser-to-local voice interaction websocket, for
   * example `ws://localhost:8300`. A URL without a path uses the
   * client's `/ws` endpoint.
   */
  interaction_endpoint: string,
  /**
   * HTTP endpoint of the DH2D server used for voice-client avatar
   * operations: avatar discovery and the direct WebRTC offer exchange,
   * for example `http://192.168.10.23:32107`. It is independent of the
   * global legacy `Config.endpoint`; a partial runtime config that omits
   * it falls back to that legacy endpoint.
   */
  dh2d_endpoint?: string,
  /**
   * Optional voice session identity; generated when omitted.
   */
  sessionId?: string,
  /**
   * Explicit local WeChat binding plugin endpoint. There is no SDK default or
   * discovery path; the consuming application supplies this value.
   */
  wechatPluginEndpoint?: string,
  /**
   * Optional generic frontend tool handler. When omitted, a configured
   * `wechatPluginEndpoint` installs the built-in WeChat binding handler.
   */
  frontendToolHandler?: VoiceClientToolHandler,
}

/**
 * Configuration options for a session.
 */
export type DH2DSessionConfig = {
  /**
   * Unique identifier for the session.
   * @default Random string generated from Math.random()
   */
  sessionId?: string
  /**
   * Controls audio input: false to disable, true to use default device, or a MediaStream for custom input.
   * @default false
   */
  audioInput?: boolean | MediaStream
  /**
   * Identifier for the video to be used in the session.
   * @default 'liruyun'
   */
  videoId?: string
  /**
   * The frame rate of the video.
   * @default 25
   */
  frameRate?: number
  /**
   * Configuration for WebRTC connections.
   * @default {}
   */
  rtcConfiguration?: RTCConfiguration

  /**
   * The interval to reconnect to the server.
   * @default 20 * 60 * 1000 (20 minutes)
   */
  reconnectInterval?: number

  /**
   * The timeout for the establishing connection.
   * @default 60 * 1000 (60 seconds)
   */
  connectTimeout?: number

  /**
   * The maximum duration difference between the audio and video.
   * @default 10 * 1000 (10 seconds)
   */
  maxAudioVideoDurationDifference?: number

  /**
   * The interval to send a ping to the server.
   * @default 10 * 1000 (10 seconds)
   */
  pingInterval?: number

  /**
   * The timeout for the ping to the server.
   * @default 5 * 1000 (5 seconds)
   */
  pingTimeout?: number

  /**
   * Opt-in voice-client avatar mode. When set, the session connects to the
   * voice client websocket with `mode=avatar&video_id` instead of opening a
   * DH2D command websocket; the client owns the native DH2D session.
   */
  voiceClient?: DH2DVoiceClientConfig
}

/** A `DH2DSessionConfig` with all defaults applied; `voiceClient` stays optional. */
export type ResolvedDH2DSessionConfig = Required<Omit<DH2DSessionConfig, 'voiceClient'>> & {
  voiceClient?: DH2DVoiceClientConfig,
}

export type DH2DSessionEvents = DHConnectionEvents & {
  statuschange: typeof DH2DSessionStatus[number]
}
export const DH2DSessionEventTypes = [
  ...DHConnectionEventTypes,
  "statuschange",
] as const;
/**
 * Represents a session with the server.
 */
export type DH2DSession = EventSource<DH2DSessionEvents> & {
  /**
   * The unique identifier for this session.
   */
  readonly sessionId: string
  /**
   * The identifier of the video used in this session.
   */
  readonly videoId: string
  /**
   * The current status of the session.
   */
  readonly status: typeof DH2DSessionStatus[number]

  /**
   * Sends a configuration message to the server.
   * @param configMessage - The configuration message to send.
   * @returns A promise that resolves when the configuration has been sent.
   * 
   * Note: Configuration messages are automatically resent after reconnection.
   */
  readonly config: (configMessage: DHInputMessage & { type: 'config' }) => Promise<void>
  /**
   * Sends a message to the server.
   * @param message - The message to send.
   * @returns A promise that resolves when the message has been sent.
   */
  readonly send: (message: DHInputMessage) => Promise<void>
  /**
   * Closes the session.
   * @returns A promise that resolves when the session has been closed.
   */
  readonly close: () => Promise<void>
}
/**
 * Possible status values for a session.
 */

export const DH2DSessionStatus = ["pending", "connecting", "connected", "reconnecting", "closed", "failed"] as const

true satisfies UnionEqual<keyof DH2DSessionEvents, typeof DH2DSessionEventTypes[number]>
