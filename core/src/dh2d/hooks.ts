import { connect, disconnect, untilFailed } from "./connections";
import { connectPc } from "../pc";
import { DH2DSessionConfig, DH2DPlayerElements, DH2DSession } from "./types";
import { Abortable, Box } from "../types";
import { box } from "../box";

function defaultConfig(config?: DH2DSessionConfig): Required<DH2DSessionConfig> {
    return {
        ...config,
        rtcConfiguration: config?.rtcConfiguration || {},
        audioInput: config?.audioInput || false,
        sessionId: config?.sessionId || Math.random().toString(36).substring(2, 15),
        videoId: config?.videoId || 'liruyun',
        frameRate: config?.frameRate || 25,
        reconnectInterval: config?.reconnectInterval || 20 * 60 * 1000,
        connectTimeout: config?.connectTimeout || 60 * 1000,
        maxAudioVideoDurationDifference: config?.maxAudioVideoDurationDifference || 10 * 1000,
        pingInterval: config?.pingInterval || 10 * 1000,
        pingTimeout: config?.pingTimeout || 5 * 1000,
    }
}

function getOrCreatePlayer(parent: HTMLElement): DH2DPlayerElements {
    let container = parent.querySelector("#mt_dh2d_container") as HTMLDivElement;
    if (!container) {
        container = document.createElement("div");
        container.id = "mt_dh2d_container";
        parent.appendChild(container);
        container.style.width = "100%";
        container.style.height = "100%";
        container.style.position = "relative";
    }
    let video = container.querySelector("#mt_dh2d_video") as HTMLVideoElement;
    if (!video) {
        video = document.createElement("video");
        video.id = "mt_dh2d_video";
        container.appendChild(video);
        video.style.objectFit = "contain";
        video.style.position = "absolute";
        video.style.top = "0";
        video.style.left = "0";
        video.style.right = "0";
        video.style.bottom = "0";
        video.style.width = "100%";
        video.style.height = "100%";
    }
    let cover = container.querySelector("#mt_dh2d_cover") as HTMLCanvasElement;
    if (!cover) {
        cover = document.createElement("canvas");
        cover.id = "mt_dh2d_cover"
        container.appendChild(cover);
        cover.style.objectFit = "contain";
        cover.style.position = "absolute";
        cover.style.top = "0";
        cover.style.left = "0";
        cover.style.right = "0";
        cover.style.bottom = "0";
        cover.style.opacity = "0";
        cover.style.width = "100%";
        cover.style.height = "100%";
    }
    return {
        video,
        cover,
    }
}


export const globalDH2DSessions: Box<DH2DSession[]> = box([])

export const untilSessionCountLessThanOrEqualTo = (count: number) => async (session: DH2DSession, abortable: Abortable) => {
    const running = globalDH2DSessions.value.length <= count || await new Promise<boolean>(resolve => {
        abortable.onabort(() => resolve(false))
        abortable.onabort(globalDH2DSessions.on("value", sessions => {
            setTimeout(() => {
                if (sessions.length <= count) {
                    resolve(true)
                }
            }, 1000)
        }))
    })
    if (running) {
        globalDH2DSessions.value = [...globalDH2DSessions.value, session]
    }
}

async function afterClosingSession(session: DH2DSession) {
    globalDH2DSessions.value = globalDH2DSessions.value.filter(s => s !== session)
}

export const dh2dHooks = {
    defaultConfig,
    getOrCreatePlayer,
    connect,
    disconnect,
    untilFailed,
    connectPc,
    beforeConnectingSession: untilSessionCountLessThanOrEqualTo(0),
    afterClosingSession,
}