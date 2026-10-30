import { abortable, withChild } from "../abortable"
import { isLoggedIn } from "../auth"
import { box } from "../box"
import { events } from "../events"
import { hooks } from "../hooks"
import { Abortable, Box, DHInputMessage, DHOutputMessage } from "../types"
import { DH2DConnection, DH2DSession, DH2DSessionEvents, DH2DSessionEventTypes, DH2DSessionStatus } from "./types"
import { DH2DSessionConfig, DH2DPlayerElements } from "./types"
import { sendVoiceClientMessage, VoiceClientConnection } from "./voiceConnections"


/**
 * Creates a DH2D session that manages the connection to a DH2D server.
 * 
 * @param parent - The HTML element that will contain the session's player
 * @param config - Optional configuration for the DH2D session
 * @returns A DH2D session object with methods to interact with the server
 * 
 * @example
 * ```typescript
 * const container = document.getElementById('dh2d-container');
 * const session = createDH2DSession(container, {
 *   sessionId: 'optional-existing-session-id'
 * });
 * 
 * // Listen for status changes
 * session.on('statuschange', (status) => {
 *   console.log(`Session status: ${status}`);
 * });
 * 
 * // Send a message to the server
 * session.send({
 *   type: 'input',
 *   text: 'Hello, DH2D!'
 * });
 * 
 * // Disconnect when done
 * await session.close();
 * ```
 */

export function createDH2DSession(parent: HTMLElement, config?: DH2DSessionConfig): DH2DSession {
    const rootLogger = hooks.logger.push((_, ...args) => _('[dh2d]', ...args))
    let realConfig = hooks.dh2d.defaultConfig(config)
    let status: typeof DH2DSessionStatus[number] = "pending"
    const rootAbortable = abortable()
    let aborted = false
    rootAbortable.onabort(() => {
        aborted = true
    })
    const evt = events<DH2DSessionEvents>()
    let latestVoiceStatus: DHOutputMessage | undefined
    const on: typeof evt.on = (event, handler) => {
        const unsubscribe = evt.on(event, handler)
        if (event === 'message' && latestVoiceStatus && !closed && status === 'connected') {
            (handler as (_: DHOutputMessage) => void)({ ...latestVoiceStatus })
        }
        return unsubscribe
    }
    const messageBuffer: DHInputMessage[] = []
    const enqueueMessage = async (message: DHInputMessage) => {
        // Voice config has no protocol equivalent and may contain credentials.
        // Discard it before retaining or logging the original legacy payload.
        if (realConfig.voiceClient != null && message.type === 'config') return
        messageBuffer.push(message)
        rootLogger.log(`connection not established, message is enqueued and will be sent ASAP: ${JSON.stringify(message)}`)
    }
    const notConnected = () => {
        throw new Error("Trying to send message after session is closed")
    }
    const drainMessage = (connection: DH2DConnection) => {
        const sending = [...messageBuffer]
        messageBuffer.length = 0
        sending.forEach(message => void sendMessageOn(connection, message))
    }
    const sendMessage = async (ws: WebSocket, message: DHInputMessage) => {
        ws.send(JSON.stringify(message))
    }
    // In voice-client mode SDK input messages are translated into the client
    // voice protocol; the legacy DH2D JSON protocol is used otherwise.
    const sendMessageOn = async (connection: DH2DConnection, message: DHInputMessage) => {
        const voice = (connection as Partial<VoiceClientConnection>).voice
        if (voice) {
            await sendVoiceClientMessage(connection.ws, voice, message)
        } else {
            await sendMessage(connection.ws, message)
        }
    }
    let send: (message: DHInputMessage) => Promise<void> = enqueueMessage
    let configMsg: (DHInputMessage & { type: 'config' }) | undefined = undefined
    let sendConfig = async (message: DHInputMessage & { type: 'config' }) => {
        if (realConfig.voiceClient != null) return
        configMsg = message
        await send(message)
    }

    let closed = false
    let connRef: DH2DConnection | undefined = undefined
    const player = hooks.dh2d.getOrCreatePlayer(parent)
    const session: DH2DSession = {
        get sessionId() { return realConfig.sessionId },
        get videoId() { return realConfig.videoId },
        get status() { return status },
        get send() { return send },
        get config() { return sendConfig },
        close: async () => {
            if (closed) {
                return
            }
            closed = true
            rootAbortable.abort()
            player.dispose?.()
            try {
                if (connRef) {
                    await hooks.dh2d.disconnect(rootLogger, connRef, player, rootAbortable)
                }
                await Promise.race([completed, new Promise(r => setTimeout(r, 3000))])
            } catch (e: any) {
                rootLogger.error(e)
                if (e.message === 'connection aborted') {
                    return
                }
                evt.emit("statuschange", "failed")
                throw e
            } finally {
                await hooks.dh2d.afterClosingSession(session)
            }
        },
        on,
        off: evt.off,
    }

    evt.on("statuschange", _ => {
        if (_ === "failed" || _ === "closed") {
            for (const ev of DH2DSessionEventTypes) {
                evt.off(ev)
            }
        }
    })

    function onMessage(message: DHOutputMessage) {
        if (message.type === "session_ended") {
            session.close()
        } else {
            if (realConfig.voiceClient != null && message.type === 'status_change') latestVoiceStatus = { ...message }
            evt.emit("message", message)
        }
    }

    const completed = (async () => {
        let sessionLogger = rootLogger
        function emitStatus(_status: typeof DH2DSessionStatus[number]) {
            sessionLogger.log(`status changing from ${status} to ${_status}`)
            status = _status
            if (_status !== 'connected') latestVoiceStatus = undefined
            evt.emit("statuschange", _status)
        }
        await withChild(rootAbortable, _ => hooks.dh2d.beforeConnectingSession(session, _))
        if (aborted) {
            emitStatus("closed")
            send = notConnected
            return
        }
        // Voice-client mode authenticates and allocates the DH2D session
        // through the local voice client. The legacy DH2D /logged_in gate is
        // not part of that path and is absent from the voice-enabled server.
        if (realConfig.voiceClient == null && !await isLoggedIn()) {
            rootLogger.error("unauthorized")
            emitStatus("failed")
            send = notConnected
            return
        }
        const voiceClientMode = realConfig.voiceClient != null
        const connectHook = voiceClientMode ? hooks.dh2d.connectVoiceClient : hooks.dh2d.connect
        const disconnectHook: (logger: ReturnType<typeof hooks.logger.push>, connection: DH2DConnection, elements: DH2DPlayerElements, abortable: Abortable) => Promise<void> =
            voiceClientMode
                ? (logger, connection, elements, abortable) => hooks.dh2d.disconnectVoiceClient(logger, connection, elements, abortable)
                : hooks.dh2d.disconnect
        let connection: DH2DConnection = await withChild(rootAbortable, (_) => connectHook(rootLogger, player, realConfig, _))
        try {
            if (aborted) {
                emitStatus("closed")
                send = notConnected
                return
            }
            realConfig.sessionId = connection.sessionId
            sessionLogger = rootLogger.push((_, ...args) => _(`[s:${connection.sessionId}]`, ...args))
            send = _ => sendMessageOn(connection, _)
            drainMessage(connection)
            connection.on("message", onMessage)
            connection.on("audio", _ => evt.emit("audio", _))
            if (configMsg) {
                await send(configMsg)
            }
            if (aborted) {
                emitStatus("closed")
                send = notConnected
                await withChild(rootAbortable, (_) => disconnectHook(sessionLogger, connection, player, _))
                return
            }
            emitStatus("connected")
            while (!aborted) {
                await withChild(rootAbortable, _ => hooks.dh2d.untilFailed(
                    sessionLogger,
                    connection,
                    player,
                    realConfig,
                    _,
                ))
                emitStatus("reconnecting")
                send = enqueueMessage
                await withChild(rootAbortable, _ => disconnectHook(sessionLogger, connection, player, _))
                if (aborted) {
                    emitStatus("closed")
                    send = notConnected
                    return
                }
                if (realConfig.voiceClient == null && !await isLoggedIn()) {
                    rootLogger.error("unauthorized")
                    emitStatus("failed")
                    send = notConnected
                    return
                }
                connection = await withChild(rootAbortable, _ => connectHook(rootLogger, player, realConfig, _))
                realConfig.sessionId = connection.sessionId
                sessionLogger = rootLogger.push((_, ...args) => _(`[s:${connection.sessionId}]`, ...args))
                connection.on("message", onMessage)
                connection.on("audio", _ => evt.emit("audio", _))
                emitStatus("connected")
                send = async _ => sendMessageOn(connection, _)
                if (configMsg) {
                    await send(configMsg)
                }
                drainMessage(connection)
            }
        } finally {
            emitStatus("closed")
            send = notConnected
            disconnectHook(sessionLogger, connection, player, abortable())
        }
    })()

    return session
}
