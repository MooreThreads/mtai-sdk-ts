export type LocalServiceStatus = {
    running: boolean
    creating: boolean
    destroying: boolean
    debounce_period: number
}

export const LocalServices = ['llm', 'tts', 'asr', 'emb', 'sec', 'dh2d'] as const