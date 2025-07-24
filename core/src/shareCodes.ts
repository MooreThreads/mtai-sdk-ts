import { config } from "./config"

export async function getShareCode(): Promise<string> {
    const { endpoint } = config()
    const response = await fetch(`${endpoint}/api/v1/share_code`)
    const body = await response.json()
    return body.bundle_share_code
}

export async function setShareCode(code: string): Promise<void> {
    const { endpoint } = config()
    const response = await fetch(`${endpoint}/api/v1/share_code`, {
        method: 'POST',
        body: JSON.stringify({ bundle_share_code: code })
    })
}