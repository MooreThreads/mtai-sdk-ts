import { ComponentStatus } from "./types";
import { EventSource, EventTarget } from "../types";
import { events } from "../events";
import { refCountedEvents } from "../refCountedEvents";
import { config } from "../config";

const globalComponentEvents = refCountedEvents<ComponentStatus[]>(async () => {
    let evt = events<{ value: ComponentStatus[] }>()
    let running = true

    const connectOnce = async () => {
        const { endpoint } = config()
        const response = await fetch(`${endpoint}/api/v1/components`, {
            headers: {
                'Accept': 'text/event-stream',
                'Cache-Control': 'no-cache'
            }
        })

        if (!response.ok) {
            throw new Error(`SSE request failed: ${response.status}`)
        }

        const reader = response.body?.getReader()
        const decoder = new TextDecoder()

        if (reader) {
            const readStream = async () => {
                try {
                    while (running) {
                        const { done, value } = await reader.read()
                        if (done) break

                        const chunk = decoder.decode(value, { stream: true })
                        const lines = chunk.split('\n')

                        for (const line of lines) {
                            if (line.startsWith('data: ')) {
                                try {
                                    const data = JSON.parse(line.slice(6))
                                    evt.emit('value', data)
                                } catch (error) {
                                    console.error('Failed to parse SSE data:', error)
                                }
                            }
                        }
                    }
                } catch (error) {
                    console.error('SSE stream error:', error)
                }
            }

            readStream()
        }
    }

    const retry = async () => {
        while (running) {
            let retryCount = 0
            try {
                await connectOnce()
            } catch (error) {
                retryCount ++
                console.error('Connection failed:', error)
                console.log(`Retrying in 2 seconds... (attempt ${retryCount + 1})`)
                await new Promise(resolve => setTimeout(resolve, 2000))
            }
        }
    }

    retry()

    return [evt, async () => {
        running = false
    }]
})


async function componentAction(name: string, action: 'update' | 'cancel_update') {
    const { endpoint } = config()
    const response = await fetch(`${endpoint}/api/v1/component/${name}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ action })
    })
    
    if (!response.ok) {
        const body = await response.json()
        throw new Error(body.message)
    }
}

export function observeComponents(cb: (_: ComponentStatus[]) => void): () => void {
    return globalComponentEvents.on('value', cb)
}

export async function updateComponent(name: string) {
    return await componentAction(name, 'update')
}

export async function cancelUpdateComponent(name: string) {
    return await componentAction(name, 'cancel_update')
}