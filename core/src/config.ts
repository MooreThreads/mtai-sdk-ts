import { Config } from "./types";

// Explicit overrides retain replacement semantics; omitted keys use SDK defaults.
const requiredKeys: (keyof Config)[] = ["endpoint"]

function defaults(): Config {
    return {
        endpoint: 'http://localhost:32101',
        voiceClient: {
            interaction_endpoint: 'http://127.0.0.1:8780',
            dh2d_endpoint: 'http://127.0.0.1:32106',
            sessionId: 'avatar-channel-session',
            wechatPluginEndpoint: 'http://127.0.0.1:8781',
        },
        show_turn_id: false,
    }
}

let _config: Config = defaults()

export function config() {
    return {..._config}
}

export function setConfig(config: Config) {
    for (const key of requiredKeys) {
        if (!config[key]) {
            throw new Error(`config key ${key} is required`)
        }
    }
    _config = {...defaults(), ...config}
}