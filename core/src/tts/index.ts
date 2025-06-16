import { config as rootConfig } from "../config"
import { Voice } from "./types"

/**
 * Fetches the available TTS voices from the server.
 * 
 * @returns A promise that resolves to an array of available Voice objects
 * @throws Error if the request fails or returns a non-200 status
 * 
 * @example
 * ```typescript
 * const voices = await getTtsVoices();
 * console.log(voices); // [{ code: 'en-US-female', display_name: 'English (US) Female', ... }]
 * ```
 */
export async function getTtsVoices(): Promise<Voice[]> {
    const { endpoint } = rootConfig()
    const url = new URL(`${endpoint}/api/v1/tts/voices`)
    
    const response = await fetch(url.toString())
    
    if (!response.ok) {
        throw new Error(`Failed to fetch TTS voices: ${response.status} ${response.statusText}`)
    }
    
    const voices: Voice[] = await response.json()
    return voices
}
