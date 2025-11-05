import { LocalServices, LocalServiceStatus } from "./types"
import { config } from "../config"

export async function getLocalServiceStatuses(): Promise<Record<typeof LocalServices[number], LocalServiceStatus>> {
    const { endpoint } = config()
    const response = await fetch(`${endpoint}/api/v1/local_services`)
    if (!response.ok) {
        const body = await response.json()
        throw new Error(body.message)
    }
    const body = await response.json()
    return body
}

async function _configLocalService(service: typeof LocalServices[number], action: 'start' | 'restart' | 'destroy'): Promise<void> {
    const { endpoint } = config()
    const response = await fetch(`${endpoint}/api/v1/local_services/${service}`, {
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
    const body = await response.json()
    return body
}

export async function startLocalService(service: typeof LocalServices[number]): Promise<void> {
    return await _configLocalService(service, 'start')
}

export async function restartLocalService(service: typeof LocalServices[number]): Promise<void> {
    return await _configLocalService(service, 'restart')
}

export async function destroyLocalService(service: typeof LocalServices[number]): Promise<void> {
    return await _configLocalService(service, 'destroy')
}