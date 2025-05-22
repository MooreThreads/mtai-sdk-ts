import { config } from "./config"

export async function isLoggedIn() {
    const { endpoint } = config()
    const url = new URL(`${endpoint}/api/v1/logged_in`)
    url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'https:' : 'http:'
    const response = await fetch(url)
    if (!response.ok) {
        throw new Error(`Failed to check if logged in: ${response.statusText}`)
    }
    const body = await response.json()
    return body.logged_in
}

export async function setAuth(auth: { access_token?: string}) {
    const { endpoint } = config()
    const url = new URL(`${endpoint}/api/v1/set_auth`)
    url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'https:' : 'http:'
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(auth)
    })
    if (!response.ok) {
        throw new Error(`Failed to set auth: ${response.statusText}`)
    }
}