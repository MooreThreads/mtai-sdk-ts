import { abortable, withChild } from "../abortable"
import { isLoggedIn } from "../auth"
import { box } from "../box"
import { events } from "../events"
import { hooks } from "../hooks"
import { Abortable, Box, DHInputMessage, DHOutputMessage } from "../types"
import { DH2DConnection, DH2DSession, DH2DSessionEvents, DH2DSessionEventTypes, DH2DSessionStatus } from "./types"
import { DH2DSessionConfig, DH2DPlayerElements } from "./types"
import { sendVoiceClientMessage, VoiceClientConnection, VoiceProtocolError } from "./voiceConnections"
import { createSnapshotObservation, type VoiceSessionSnapshot } from '../voice/sessionSnapshot'


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
    const snapshots = createSnapshotObservation()
    const on: typeof evt.on = (event, handler) => {
        if (event === 'snapshot') return snapshots.subscribe(handler as (value: VoiceSessionSnapshot | undefined) => void)
        const unsubscribe = evt.on(event, handler)
        if (event === 'message' && latestVoiceStatus && !closed && status === 'connected') {
            (handler as (_: DHOutputMessage) => void)({ ...latestVoiceStatus })
        }
        return unsubscribe
    }
    const off = <K extends keyof DH2DSessionEvents>(event: K, handler?: (_: DH2DSessionEvents[K]) => void) => {
        if (event === 'snapshot') snapshots.unsubscribe(handler as ((value: VoiceSessionSnapshot | undefined) => void) | undefined)
        else if (handler) evt.off(event, handler)
        else evt.off(event)
    }
    const messageBuffer: { message: DHInputMessage, resolve?: () => void, reject?: (error: Error) => void }[] = []
    const rejectBuffered = (error: Error) => {
        for (const entry of messageBuffer.splice(0)) entry.reject?.(error)
    }
    const enqueueMessage = async (message: DHInputMessage) => {
        if (realConfig.voiceClient != null) {
            if (message.type === 'config' || message.type === 'ping') return
            // Wait for negotiation before deciding whether legacy replay is allowed.
            // Never report acceptance for an intent that may have to be refused.
            if (aborted) throw new Error('Voice connection closed before submission.')
            return new Promise<void>((resolve, reject) => messageBuffer.push({ message, resolve, reject }))
        }
        messageBuffer.push({ message })
        rootLogger.log(`connection not established, message is enqueued and will be sent ASAP: ${JSON.stringify(message)}`)
    }
    const notConnected = () => {
        throw new Error("Trying to send message after session is closed")
    }
    const drainMessage = (connection: DH2DConnection) => {
        const voice = (connection as Partial<VoiceClientConnection>).voice
        if (voice?.serviceNegotiated?.()) {
            rejectBuffered(new Error('Voice text or control was not submitted before readiness.'))
            return
        }
        for (const { message, resolve, reject } of messageBuffer.splice(0)) {
            void sendMessageOn(connection, message).then(resolve, reject ?? (error => rootLogger.error(error)))
        }
    }
    const sendMessage = async (ws: WebSocket, message: DHInputMessage) => {
        ws.send(JSON.stringify(message))
    }
    // In voice-client mode SDK input messages are translated into the client
    // voice protocol; the legacy DH2D JSON protocol is used otherwise.
    const sendMessageOn = async (connection: DH2DConnection, message: DHInputMessage) => {
        const { voice, sendVoice } = connection as Partial<VoiceClientConnection>
        if (sendVoice) {
            await sendVoice(message)
        } else if (voice) {
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
    const player = hooks.dh2d.getOrCreatePlayer(parent)
    let avatarOwner: { connection: Partial<VoiceClientConnection>, lifetime: AbortController } | undefined
    const session: DH2DSession = {
        get sessionId() { return realConfig.sessionId },
        get videoId() { return realConfig.videoId },
        get status() { return status },
        get snapshot() { return snapshots.value },
        get send() { return send },
        get config() { return sendConfig },
        resetAvatarPlayback: async () => {
            if (closed || aborted || status !== 'connected') return false
            const owner = avatarOwner
            if (!owner) return false
            const signal = owner.lifetime.signal
            const current = () => !signal.aborted && avatarOwner === owner && status === 'connected'
            let retire!: () => void
            const retirement = new Promise<false>(resolve => {
                retire = () => resolve(false)
                signal.addEventListener('abort', retire, { once: true })
            })
            try {
                // Retirement must not wait for Chromium's native play promise.
                return await Promise.race([retirement, owner.connection.resetAvatarPlayback?.(signal)]) === true && current()
            } catch (error) {
                if (!current()) return false
                throw error
            } finally {
                signal.removeEventListener('abort', retire)
            }
        },
        close: async () => {
            if (closed) {
                return
            }
            closed = true
            avatarOwner?.lifetime.abort()
            snapshots.publish(undefined)
            rejectBuffered(new Error('Voice connection closed before submission.'))
            rootAbortable.abort()
            player.dispose?.()
            try {
                await Promise.race([completed, new Promise(r => setTimeout(r, 3000))])
            } catch (e: any) {
                rootLogger.error(e)
                if (e.message === 'connection aborted') {
                    return
                }
                evt.emit("statuschange", "failed")
                throw e
            }
        },
        on,
        off,
    }

    evt.on("statuschange", _ => {
        if (_ === "failed" || _ === "closed") {
            for (const ev of DH2DSessionEventTypes) {
                off(ev)
            }
        }
    })

    function onMessage(message: DHOutputMessage) {
        if (closed || aborted) return
        if (message.type === "session_ended") {
            // close already logs failures; only explicit callers receive its
            // rejection. Server events have no caller to observe that promise.
            void session.close().catch(() => {})
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
            if (_status !== 'connected') {
                latestVoiceStatus = undefined
                snapshots.publish(undefined)
            }
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
        let connection!: DH2DConnection
        let terminalStatus: 'closed' | 'failed' = 'closed'
        let ownsConnection = false
        let unsubscribeSnapshot: (() => void) | undefined
        const observeSnapshot = (owner: DH2DConnection) => {
            if (!voiceClientMode) return
            const voiceConnection = owner as Partial<VoiceClientConnection>
            avatarOwner = { connection: voiceConnection, lifetime: new AbortController() }
            unsubscribeSnapshot = voiceConnection.onSnapshot?.(value => {
                if (!aborted && !closed && ownsConnection && connection === owner) snapshots.publish(value)
            })
        }
        const disconnectOwned = async () => {
            if (!ownsConnection) return
            ownsConnection = false
            avatarOwner?.lifetime.abort()
            avatarOwner = undefined
            unsubscribeSnapshot?.()
            unsubscribeSnapshot = undefined
            await disconnectHook(sessionLogger, connection, player, abortable())
        }
        try {
            connection = await withChild(rootAbortable, (_) => connectHook(rootLogger, player, realConfig, _))
            ownsConnection = true
            if (aborted) {
                emitStatus("closed")
                send = notConnected
                return
            }
            realConfig.sessionId = connection.sessionId
            sessionLogger = rootLogger.push((_, ...args) => _(`[s:${connection.sessionId}]`, ...args))
            send = _ => sendMessageOn(connection, _)
            drainMessage(connection)
            observeSnapshot(connection)
            connection.on("message", onMessage)
            connection.on("audio", _ => evt.emit("audio", _))
            if (configMsg) {
                await send(configMsg)
            }
            if (aborted) {
                emitStatus("closed")
                send = notConnected
                await disconnectOwned()
                return
            }
            emitStatus("connected")
            while (!aborted) {
                await withChild(rootAbortable, child => {
                    const transport = hooks.dh2d.untilFailed(sessionLogger, connection, player, realConfig, child)
                    const failure = (connection as Partial<VoiceClientConnection>).failure
                    // A protocol rejection must not wait for a peer's close reply.
                    // Throwing here also aborts the losing transport observer.
                    return failure ? Promise.race([transport, failure.catch(error => {
                        if (error instanceof VoiceProtocolError) throw error
                        // Ordinary connection failure retains the reconnect path.
                    })]) : transport
                })
                emitStatus("reconnecting")
                send = enqueueMessage
                await disconnectOwned()
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
                ownsConnection = true
                realConfig.sessionId = connection.sessionId
                sessionLogger = rootLogger.push((_, ...args) => _(`[s:${connection.sessionId}]`, ...args))
                observeSnapshot(connection)
                connection.on("message", onMessage)
                connection.on("audio", _ => evt.emit("audio", _))
                emitStatus("connected")
                send = async _ => sendMessageOn(connection, _)
                if (configMsg) {
                    await send(configMsg)
                }
                drainMessage(connection)
            }
        } catch (error) {
            if (!(error instanceof VoiceProtocolError)) throw error
            terminalStatus = 'failed'
        } finally {
            send = notConnected
            emitStatus(terminalStatus)
            await disconnectOwned()
        }
    })().finally(() => {
        rejectBuffered(new Error('Voice connection closed before submission.'))
        return hooks.dh2d.afterClosingSession(session)
    })
    // The operation can fail before a caller closes the session. Observe it
    // without changing the rejection seen by close's existing wait.
    void completed.catch(() => {})

    return session
}
