import { EventSource, Box } from "./types"
import { box } from "./box"
import { AsyncQueue } from "./queue"
import { asyncMutex } from "./mutex"

export function refCountedEvents<T>(f: () => Promise<[EventSource<{value: T}>, () => Promise<void>]>): EventSource<{value: T}> {
    const listeners: Box<((_: any) => void)[]> = box([])
    let stop: (() => Promise<void>) | undefined = undefined
    const mutex = asyncMutex()

    const on = (event: 'value', handler: (_: any) => void) => {
        listeners.value = [...listeners.value, handler]
        return () => off(event, handler)
    }
    const off = (event: 'value', handler?: (_: any) => void) => {
        if (handler) {
            listeners.value = listeners.value.filter(h => h !== handler)
        } else {
            listeners.value = []
        }
    }
    const emit = (data: T) => {
        listeners.value.forEach(handler => handler(data))
    }
    listeners.on('value', async (data: any[]) => {
        await mutex.acquire()
        try {
            if (data.length > 0 && !stop) {
                let [evt, stopUpstream] = await f()
                let stopObserve = evt.on('value', emit)
                stop = async () => {
                    await stopUpstream()
                    stopObserve()
                }
            } else if (data.length == 0 && stop) {
                stop()
                stop = undefined
            }
        } finally {
            mutex.release()
        }
    })
    return { on, off, }
}