import { config } from "../config"
import { Avatar } from "./types"

export async function getAvatars(): Promise<Avatar[]> {
    const { endpoint } = config()
    const response = await fetch(`${endpoint}/api/v1/avatars`)
    const body = await response.json()
    return body
}
