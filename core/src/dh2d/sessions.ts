import { abortable, withChild } from "../abortable"
import { isLoggedIn } from "../auth"
import { box } from "../box"
import { events } from "../events"
import { hooks } from "../hooks"
import { Box, DHInputMessage } from "../types"
import { DH2DSession, DH2DSessionEvents, DH2DSessionEventTypes, DH2DSessionStatus } from "./types"
import { DH2DSessionConfig } from "./types"


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
    const messageBuffer: DHInputMessage[] = []
    const enqueueMessage = async (message: DHInputMessage) => {
        messageBuffer.push(message)
        rootLogger.log(`connection not established, message is enqueued and will be sent ASAP: ${JSON.stringify(message)}`)
    }
    const notConnected = () => {
        throw new Error("Trying to send message after session is closed")
    }
    const drainMessage = (ws: WebSocket) => {
        const sending = [...messageBuffer]
        messageBuffer.length = 0
        sending.forEach(message => ws.send(JSON.stringify(message)))
    }
    const sendMessage = async (ws: WebSocket, message: DHInputMessage) => {
        ws.send(JSON.stringify(message))
    }
    let send: (message: DHInputMessage) => Promise<void> = enqueueMessage
    let configMsg: (DHInputMessage & { type: 'config' }) | undefined = undefined
    let sendConfig = async (message: DHInputMessage & { type: 'config' }) => {
        configMsg = message
        await send(message)
    }

    const session: DH2DSession = {
        get sessionId() { return realConfig.sessionId },
        get videoId() { return realConfig.videoId },
        get status() { return status },
        get send() { return send },
        get config() { return sendConfig },
        close: async () => {
            rootAbortable.abort()
            try {
                await completed
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
        ...(({ on, off }) => ({ on, off }))(evt),
    }

    evt.on("statuschange", _ => {
        if (_ === "failed" || _ === "closed") {
            for (const ev of DH2DSessionEventTypes) {
                evt.off(ev)
            }
        }
    })

    const completed = (async () => {
        let sessionLogger = rootLogger
        function emitStatus(_status: typeof DH2DSessionStatus[number]) {
            sessionLogger.log(`status changing from ${status} to ${_status}`)
            status = _status
            evt.emit("statuschange", _status)
        }
        await withChild(rootAbortable, _ => hooks.dh2d.beforeConnectingSession(session, _))
        if (aborted) {
            emitStatus("closed")
            send = notConnected
            return
        }
        if (!await isLoggedIn()) {
            rootLogger.error("unauthorized")
            emitStatus("failed")
            send = notConnected
            return
        }
        const player = hooks.dh2d.getOrCreatePlayer(parent)
        let connection = await withChild(rootAbortable, (_) => hooks.dh2d.connect(rootLogger, player, realConfig, _))
        try {
            if (aborted) {
                emitStatus("closed")
                send = notConnected
                return
            }
            realConfig.sessionId = connection.sessionId
            sessionLogger = rootLogger.push((_, ...args) => _(`[s:${connection.sessionId}]`, ...args))
            send = _ => sendMessage(connection.ws, _)
            drainMessage(connection.ws)
            connection.on("message", _ => evt.emit("message", _))
            connection.on("audio", _ => evt.emit("audio", _))
            if (configMsg) {
                await send(configMsg)
            }
            if (aborted) {
                emitStatus("closed")
                send = notConnected
                await withChild(rootAbortable, (_) => hooks.dh2d.disconnect(sessionLogger, connection, player, _))
                return
            }
            emitStatus("connected")
            while (!aborted) {
                await withChild(rootAbortable, _ => hooks.dh2d.untilFailed(sessionLogger, connection, realConfig, _))
                emitStatus("reconnecting")
                send = enqueueMessage
                await withChild(rootAbortable, _ => hooks.dh2d.disconnect(sessionLogger, connection, player, _))
                if (aborted) {
                    emitStatus("closed")
                    send = notConnected
                    return
                }
                if (!await isLoggedIn()) {
                    rootLogger.error("unauthorized")
                    emitStatus("failed")
                    send = notConnected
                    return
                }
                connection = await withChild(rootAbortable, _ => hooks.dh2d.connect(rootLogger, player, realConfig, _))
                realConfig.sessionId = connection.sessionId
                sessionLogger = rootLogger.push((_, ...args) => _(`[s:${connection.sessionId}]`, ...args))
                connection.on("message", _ => evt.emit("message", _))
                connection.on("audio", _ => evt.emit("audio", _))
                emitStatus("connected")
                send = async _ => sendMessage(connection.ws, _)
                if (configMsg) {
                    await send(configMsg)
                }
                drainMessage(connection.ws)
            }
        } finally {
            emitStatus("closed")
            send = notConnected
            hooks.dh2d.disconnect(sessionLogger, connection, player, abortable())
        }
    })()

    return session
}


