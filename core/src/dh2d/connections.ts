import { withChild } from "../abortable"
import { events } from "../events"

import { connectPc } from "../pc"
import { Abortable, DHOutputMessageType, Diff, Logger, DHConnectionEventTypes, DHConnectionEvents } from "../types"
import { config as rootConfig } from "../config"
import { DH2DSessionConfig } from "./types"
import { DH2DPlayerElements } from "./types"
import { DH2DConnection } from "./types"

async function gc() {
    await new Promise<void>(resolve => {
        queueMicrotask(() => {
            let img: HTMLImageElement | null = document.createElement("img");
            img.src = window.URL.createObjectURL(new Blob([new ArrayBuffer(5e+7)]));
            img.onerror = function () {
                window.URL.revokeObjectURL(this.src);
                img = null
                resolve()
            }
        })
    })
}

export async function connect(logger: Logger, elements: DH2DPlayerElements, config: Required<DH2DSessionConfig>, abortable: Abortable): Promise<DH2DConnection> {
    const { endpoint } = rootConfig()
    const rootLogger = logger.push((_, ...args) => _('[connect]', ...args))
    let videoVisible = false
    async function connectOnce(time: number, innerAbortable: Abortable) {
        let running = true
        innerAbortable.onabort(() => {
            running = false
        })
        logger = rootLogger.push((_, ...args) => _(`[attempt:${time}]`, ...args))
        logger.log('enter')
        const url = new URL(`${endpoint}/api/v1/digital_human`)
        if (config.sessionId) {
            url.searchParams.set("session_id", config.sessionId)
        }
        url.searchParams.set("video_id", config.videoId)
        url.searchParams.append("task", "dh_2d")
        if (config.audioInput) {
            url.searchParams.append("task", "audio_input")
        }
        url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:'
        logger.log('connecting websocket', url.toString())
        const ws = new WebSocket(url.toString())
        innerAbortable.onabort(() => {
            ws.close()
        })
        const pc = new RTCPeerConnection(config.rtcConfiguration)
        innerAbortable.onabort(() => {
            pc.close()
        })
        const audioPc = config.audioInput ? new RTCPeerConnection(config.rtcConfiguration) : undefined
        innerAbortable.onabort(() => {
            audioPc?.close()
        })
        let sessionId = config.sessionId
        let sessionLogger = logger
        const pcConnected = new Promise<DH2DConnection>((resolve, reject) => {
            abortable.onabort(() => {
                reject(new Error('connection aborted'))
            })
            const evt = events<DHConnectionEvents>()
            const connection: Diff<DH2DConnection, typeof evt> = {
                get ws() { return ws },
                get pc() { return pc },
                get audioPc() { return audioPc },
                get sessionId() { return sessionId },
            }
            ws.onmessage = (event) => {
                if (!running) return
                if (typeof event.data === "string") {
                    const message = JSON.parse(event.data)
                    if (message.type === 'dh_2d_session_ready') {
                        sessionId = message.session_id
                        sessionLogger = logger.push((_, ...args) => _(`[s:${sessionId}]`, ...args))
                        pc.addTransceiver('video', { direction: 'recvonly' });
                        pc.addTransceiver('audio', { direction: 'recvonly' });
                        const pcUrl = new URL(`${endpoint}/api/v1/session/${sessionId}/offer`)
                        pcUrl.protocol = pcUrl.protocol === 'https:' || pcUrl.protocol === 'wss:' ? 'https:' : 'http:'
                        sessionLogger.log('pc url', pcUrl.toString())
                        const tasks = [
                            connectPc(pc, pcUrl.toString()).then(() => sessionLogger.log('pc connected')),
                        ]
                        if (audioPc) {
                            const audioPcUrl = new URL(`${endpoint}/api/v1/session/${sessionId}/offer/audio`)
                            audioPcUrl.protocol = audioPcUrl.protocol === 'https:' || audioPcUrl.protocol === 'wss:' ? 'https:' : 'http:'
                            sessionLogger.log('audio pc url', audioPcUrl.toString())
                            tasks.push((async () => {
                                audioPc.addTransceiver('audio', { direction: 'sendonly' });
                                const audioStream = typeof config.audioInput === 'boolean' ?
                                    await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true }, video: false, }) : config.audioInput
                                if (!running) return
                                audioStream.getAudioTracks().forEach(_ => audioPc.addTrack(_));
                                await connectPc(audioPc, audioPcUrl.toString())
                                sessionLogger.log('audio pc connected')
                            })())
                        }
                        Promise.all(tasks).then(() => resolve({
                            ...connection,
                            ...(({ on, off }) => ({ on, off }))(evt),
                        })).catch(reject)
                    }
                    if (DHOutputMessageType.includes(message.type)) {
                        evt.emit("message", message)
                    }
                } else {
                    evt.emit("audio", event.data)
                }
            }
        })
        const videoReady = new Promise<void>((resolve,) => {
            const video = elements.video
            let videoTrack = false
            let audioTrack = false
            const onTrack = (event: RTCTrackEvent) => {
                if (!running) return
                if (event.track.kind === 'video') {
                    sessionLogger.log('video track added')
                    videoTrack = true
                } else if (event.track.kind === 'audio') {
                    sessionLogger.log('audio track added')
                    audioTrack = true
                }
                if (videoTrack && audioTrack) {
                    video.srcObject = event.streams[0]
                    innerAbortable.onabort(() => video.srcObject = null)
                    sessionLogger.log('video source ready')
                }
            }
            pc.addEventListener("track", onTrack)
            innerAbortable.onabort(() => pc.removeEventListener("track", onTrack))

            // 用于标记是否已经播放了第一帧
            let firstFramePlayed = false;

            const onFirstFrame = () => {
                if (firstFramePlayed) return;
                firstFramePlayed = true;
                videoVisible = true;
                video.removeEventListener('timeupdate', onFirstFrame)
                video.removeEventListener('canplay', onCanPlay);
                
                sessionLogger.log('first video frame played')
                resolve()
            };

            // 监听第一帧
            video.addEventListener('timeupdate', onFirstFrame, { once: true });

            const onCanPlay = () => {
                sessionLogger.log('video canplay')
                video.play()
            }
            video.addEventListener("canplay", onCanPlay)
            innerAbortable.onabort(() => {
                video.removeEventListener("canplay", onCanPlay)
                video.removeEventListener('timeupdate', onFirstFrame)
            })
        })
        return await Promise.all([pcConnected, videoReady]).then(([connection, _]) => connection).catch(e => {
            sessionLogger.error(e)
            throw e
        }).finally(() => {
            sessionLogger.log('exit')
        })
    }
    for (let i = 0; ; i++) {
        try {
            videoVisible = false
            return await withChild(abortable, async (innerAbortable) => {
                const tasks = [connectOnce(i, innerAbortable)]
                const connectTimeout = config.connectTimeout
                if (connectTimeout > 0) {
                    tasks.push(new Promise<DH2DConnection>((_, reject) => {
                        setTimeout(() => reject(new Error(`connect timeout after ${connectTimeout}ms`)), connectTimeout)
                    }))
                }
                return await Promise.race(tasks)
            })
        } catch (e: any) {
            if (videoVisible) {
                drawCover(logger, elements)
            }
            logger.error(e)
            if (e.message === 'connection aborted') {
                throw e
            }
            await gc()
            await new Promise(resolve => setTimeout(resolve, 2000))
        }
    }
}

function drawCover(logger: Logger, elements: DH2DPlayerElements) {
    logger.log('draw cover')
    const cover = elements.cover
    if (cover) {
        cover.width = elements.video.videoWidth
        cover.height = elements.video.videoHeight
        logger.log(`drawing cover ${cover.width}x${cover.height}`)
        const ctx = cover.getContext('2d')
        if (ctx) {
            ctx.drawImage(elements.video, 0, 0, cover.width, cover.height)
        }
        cover.style.opacity = "1"
    }
}

export async function disconnect(logger: Logger, connection: DH2DConnection, elements: DH2DPlayerElements, abortable: Abortable) {
    logger = logger.push((_, ...args) => _('[disconnect]', ...args))
    logger.log('enter')
    try {
        drawCover(logger, elements)
        connection.ws.close()
        connection.pc.close()
        connection.audioPc?.close()
        for (const events of DHConnectionEventTypes) {
            connection.off(events)
        }
        await gc()
    } catch (e) {
        logger.error(e)
        throw e
    } finally {
        logger.log('exit')
    }
}

export async function untilFailed(logger: Logger, connection: DH2DConnection, config: Required<DH2DSessionConfig>, abortable: Abortable) {
    logger = logger.push((_, ...args) => _('[untilFailed]', ...args))
    logger.log('enter')
    let running = true
    const connectionStart = Date.now()
    const dispose: (() => void)[] = []
    return await new Promise<void>((resolve) => {
        abortable.onabort(() => {
            running = false
            resolve()
        })
        connection.ws.addEventListener("close", () => {
            if (!running) return
            logger.log('reconnect due to websocket close')
            running = false
            resolve()
        })
        const closedStates = ["disconnected", "failed", "closed"]
        connection.pc.addEventListener("connectionstatechange", () => {
            if (!running) return
            if (closedStates.includes(connection.pc.connectionState)) {
                logger.log('reconnect due to pc connection state', connection.pc.connectionState)
                running = false
                resolve()
            }
        })
        const audioPc = connection.audioPc
        if (audioPc) {
            audioPc.addEventListener("connectionstatechange", () => {
                if (!running) return
                if (closedStates.includes(audioPc.connectionState)) {
                    logger.log('reconnect due to audio pc connection state', audioPc.connectionState)
                    running = false
                    resolve()
                }
            })
        } else {
            let numFrames = 0
            const statTask = setInterval(async () => {
                if (!running) return
                const stats = await connection.pc.getStats();
                if (!running) return
                for (const [_, stat] of Object.entries(stats)) {
                    if (stat.type === 'inbound-rtp' && stat.kind === 'video') {
                        if (numFrames < stat.framesReceived) {
                            numFrames = stat.framesReceived;
                            connection.ws.send(
                                JSON.stringify({
                                    type: 'dh_2d_stats',
                                    played_frames: numFrames
                                })
                            );
                        }
                    }
                }
            }, 200)
            dispose.push(() => clearInterval(statTask))
        }
        const reconnectInterval = config.reconnectInterval
        if (reconnectInterval > 0) {
            let status = 'sleeping'
            const reconnectTimeout = setTimeout(() => {
                if (status === 'sleeping') {
                    logger.log(`reconnect after ${reconnectInterval}ms`)
                    running = false
                    resolve()
                }
            }, reconnectInterval)
            dispose.push(() => clearTimeout(reconnectTimeout))
            connection.on("message", msg => {
                if (!running) return
                if (msg.type === "status_change") {
                    logger.log(`status change to ${msg.status}`)
                    status = msg.status
                    if (["sleeping", "listening"].includes(msg.status) && Date.now() - connectionStart > reconnectInterval) {
                        logger.log(`reconnect after ${reconnectInterval}ms`)
                        running = false
                        resolve()
                        return
                    }
                }
            })
        }
        const maxAudioVideoDurationDifference = config.maxAudioVideoDurationDifference
        if (maxAudioVideoDurationDifference > 0) {
            let checkDurationDiffTask = 0
            connection.pc.addEventListener("connectionstatechange", (event) => {
                if (connection.pc.connectionState === "connected" && !checkDurationDiffTask) {
                    checkDurationDiffTask = setInterval(async () => {
                        if (!running) {
                            return
                        }
                        const stats = await connection.pc.getStats()
                        let videoFrames = 0;
                        let audioSamplesDuration = 0;

                        stats.forEach((stat) => {
                            if (stat.type === 'inbound-rtp' && stat.kind === 'audio') {
                                audioSamplesDuration = stat.totalSamplesDuration
                            } else if (stat.type === 'inbound-rtp' && stat.kind === 'video') {
                                videoFrames = stat.framesReceived
                            }
                        })
                        const durationDifference = Math.abs(audioSamplesDuration - videoFrames / config.frameRate)
                        if (durationDifference >= maxAudioVideoDurationDifference) {
                            logger.error(`reconnect due to audio/video duration difference reached ${durationDifference}ms`)
                            running = false
                            resolve()
                        }
                    }, 1000)
                    dispose.push(() => clearInterval(checkDurationDiffTask))
                }
            })
        }
        const pingInterval = config.pingInterval
        const pingTimeout = config.pingTimeout
        if (pingInterval > 0 && pingTimeout > 0) {
            const pong: Record<string, () => void> = {}
            connection.on("message", msg => {
                if (msg.type === "pong") {
                    pong[msg.timestamp]?.()
                    delete pong[msg.timestamp]
                }
            })
            const pingIntervalTask = setInterval(async () => {
                if (!running) {
                    return
                }
                const timestamp = new Date().toISOString()
                const result = await Promise.race([
                    new Promise<boolean>((resolve) => {
                        pong[timestamp] = () => resolve(true)
                        connection.ws.send(JSON.stringify({ type: 'ping', timestamp }))
                    }),
                    new Promise<boolean>((resolve) => {
                        setTimeout(() => resolve(false), pingTimeout)
                    })
                ])
                if (!result) {
                    logger.error(`reconnect due to ping timeout after ${pingTimeout}ms`)
                    running = false
                    resolve()
                }
            }, pingInterval)
            dispose.push(() => clearInterval(pingIntervalTask))
        }
    }).catch(e => {
        logger.error(e)
        throw e
    }).finally(() => {
        logger.log('exit')
        dispose.forEach(fn => fn())
    })
}

