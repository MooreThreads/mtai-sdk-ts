import { config } from "../config"
import { Avatar } from "./types"

// Matches URLs with a scheme such as `https:`, `http:`, `data:`, or `blob:`.
const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:/i

function posterUrl(endpoint: string, id: string, poster: unknown): string {
    if (typeof poster === "string" && ABSOLUTE_URL.test(poster)) {
        return poster
    }
    return `${endpoint}/api/v1/video_configs/${id}/poster`
}

/**
 * Fetches the available avatars from the DH2D server.
 *
 * The server exposes avatar (video) configurations as a single object keyed
 * by avatar id at `GET /api/v1/video_configs`. Each entry is normalized to
 * the SDK `Avatar` shape; poster URLs that are not already absolute are
 * replaced with the server's poster route for that avatar. When a
 * `voiceClient.dh2d_endpoint` is configured, discovery and poster URLs target
 * that endpoint; otherwise they use the legacy global `endpoint`.
 *
 * @returns A promise that resolves to an array of available Avatar objects
 * @throws Error if the request fails or returns a non-200 status
 *
 * @example
 * ```typescript
 * const avatars = await getAvatars();
 * console.log(avatars); // [{ id: 'xiaomai', name: 'Xiao Mai', poster: 'http://localhost:32101/api/v1/video_configs/xiaomai/poster' }]
 * ```
 */
export async function getAvatars(): Promise<Avatar[]> {
    const { endpoint, voiceClient } = config()
    // Voice-client avatar discovery targets the configured voice-client DH2D
    // endpoint; without it the legacy service endpoint is used.
    const avatarEndpoint = voiceClient?.dh2d_endpoint || endpoint
    const response = await fetch(`${avatarEndpoint}/api/v1/video_configs`)

    if (!response.ok) {
        throw new Error(`Failed to fetch avatars: ${response.status} ${response.statusText}`)
    }

    const body: unknown = await response.json()
    if (body == null || typeof body !== "object" || Array.isArray(body)) {
        return []
    }

    const avatars: Avatar[] = []
    for (const [id, entry] of Object.entries(body)) {
        if (entry == null || typeof entry !== "object") {
            continue
        }
        const record = entry as Record<string, unknown>
        const name = typeof record.name === "string" ? record.name : undefined
        avatars.push({
            id,
            ...(name !== undefined ? { name } : {}),
            poster: posterUrl(avatarEndpoint, id, record.poster),
        })
    }
    return avatars
}
