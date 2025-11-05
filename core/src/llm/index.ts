import { config } from "../config"
import { LlmModel, LocalLLMStatus } from "./types"

export async function getLocalLlmStatus(): Promise<LocalLLMStatus> {
    const { endpoint } = config()
    const response = await fetch(`${endpoint}/api/v1/musachat_local`)
    if (!response.ok) {
        const body = await response.json()
        throw new Error(body.message)
    }
    const body = await response.json()
    return body
}

async function _configLocalLlm(input: { type: 'config', model?: string, debounce_period?: number } | { type: 'destroy' } | { type: 'start' }): Promise<void> {
    const { endpoint } = config()
    const response = await fetch(`${endpoint}/api/v1/musachat_local`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(input)
    })
    if (!response.ok) {
        const body = await response.json()
        throw new Error(body.message)
    }
    const body = await response.json()
    return body
}

export async function configLocalLlm({model, debounce_period}: {model?: string, debounce_period?: number}): Promise<void> {
    return await _configLocalLlm({ type: 'config', model, debounce_period })
}
export async function destroyLocalLlm(): Promise<void> {
    return await _configLocalLlm({ type: 'destroy' })
}
export async function startLocalLlm(): Promise<void> {
    return await _configLocalLlm({ type: 'start' })
}
export async function getLlmModels(): Promise<LlmModel[]> {
    const { endpoint } = config()
    const response = await fetch(`${endpoint}/api/v1/models`)
    if (!response.ok) {
        const body = await response.json()
        throw new Error(body.message)
    }
    const body = await response.json()
    return body
}
