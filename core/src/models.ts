import { config } from "./config"
import { DHInputMessage } from "./types"

type ConfigMessage = Required<DHInputMessage & {type: 'config'}>
type LlmModel = {
    title?: string,
    service: ConfigMessage['llm_service']
    config?: ConfigMessage['llm_config']
}
export async function getLlmModels(): Promise<LlmModel[]> {
    const { endpoint } = config()
    const response = await fetch(`${endpoint}/api/v1/models`)
    const body = await response.json()
    return body
}