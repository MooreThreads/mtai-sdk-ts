import { DHConnectionEvents, DHConnectionEventTypes, DHInputMessage, EventSource, UnionEqual } from "../types";

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
