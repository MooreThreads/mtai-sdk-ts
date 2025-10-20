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

export async function configLocalLlm(model: string): Promise<void> {
    const { endpoint } = config()
    const response = await fetch(`${endpoint}/api/v1/musachat_local`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ model })
    })
    if (!response.ok) {
        const body = await response.json()
        throw new Error(body.message)
    }
    const body = await response.json()
    return body
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
