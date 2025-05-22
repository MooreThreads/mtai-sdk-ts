import { Config } from "./types";

let _config: Config = {
    endpoint: 'http://localhost:32101'
}

export function config() {
    return {..._config}
}

export function setConfig(config: Config) {
    for (const key of Object.keys(_config) as (keyof Config)[]) {
        if (!config[key]) {
            throw new Error(`config key ${key} is required`)
        }
    }
    _config = {...config}
}