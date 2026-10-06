import { Config } from "./types";

// Keys that every setConfig call must provide; other keys (for example the
// optional voiceClient) may be freely included or omitted.
const requiredKeys: (keyof Config)[] = ["endpoint"]

let _config: Config = {
    endpoint: 'http://localhost:32101'
}

export function config() {
    return {..._config}
}

export function setConfig(config: Config) {
    for (const key of requiredKeys) {
        if (!config[key]) {
            throw new Error(`config key ${key} is required`)
        }
    }
    _config = {...config}
}