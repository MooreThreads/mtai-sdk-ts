import { DHInputMessage } from "../types"
export type LocalLLMStatus = {
    running: boolean
    models: {
        title: string
    }[]
}

type ConfigMessage = Required<DHInputMessage & { type: 'config'} >
export type LlmModel = {
    title?: string
    service: ConfigMessage['llm_service']
    config?: ConfigMessage['llm_config']
}
