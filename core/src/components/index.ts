import { ComponentStatus } from "./types";
import { events } from "../events";
import { refCountedEvents } from "../refCountedEvents";
import { config } from "../config";
import { hooks } from "../hooks";
const globalComponentEvents = refCountedEvents<ComponentStatus[]>(async () => {
    const logger = hooks.logger.push((_, ...args) => _('[components]', ...args))
    let evt = events<{ value: ComponentStatus[] }>()
    let running = true
    let currentEventSource: EventSource | undefined = undefined

    const connectOnce = () => new Promise((resolve, reject) => {
        const { endpoint } = config()
        const eventSource = new EventSource(`${endpoint}/api/v1/components`, {
            withCredentials: true
        })
        currentEventSource = eventSource

        eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data)
                evt.emit('value', data)
            } catch (error) {
                logger.error('Failed to parse SSE data:', error)
            }
        }
        
        eventSource.onerror = (error) => {
            logger.error('SSE connection error:', error)
            eventSource.close()
            reject(error)
        }
    })

    const retry = async () => {
        while (running) {
            let retryCount = 0
            try {
                await connectOnce()
            } catch (error) {
                retryCount ++
                logger.error('Connection failed:', error)
                logger.log(`Retrying in 2 seconds... (attempt ${retryCount + 1})`)
                await new Promise(resolve => setTimeout(resolve, 2000))
            } finally {
                currentEventSource = undefined
            }
        }
    }

    retry()

    return [evt, async () => {
        running = false
        currentEventSource?.close()
        currentEventSource = undefined
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