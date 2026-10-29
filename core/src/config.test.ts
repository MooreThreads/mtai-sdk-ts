import { config, setConfig } from './config'
import type { Config } from './types'
import type { DH2DSessionConfig, DH2DVoiceClientConfig } from './dh2d/types'

// Compile-time public API checks: UI observers and per-session stripe flags are not supported.
const globalDisplay: Config = { endpoint: 'http://localhost', show_turn_id: true }
const sessionDisplay: DH2DSessionConfig = {
  // @ts-expect-error show_turn_id is global only
  show_turn_id: true,
}
const bindingConfig: DH2DVoiceClientConfig = {
  interaction_endpoint: 'ws://localhost',
  // @ts-expect-error binding UI is SDK-owned, not consumer callbacks
  wechatBinding: { onSnapshot() {}, onError() {}, onWorkflow() {} },
}
void globalDisplay; void sessionDisplay; void bindingConfig

const DEFAULT_ENDPOINT = 'http://localhost:32101'
const DEFAULT_VOICE = {
  interaction_endpoint: 'http://127.0.0.1:8780',
  dh2d_endpoint: 'http://127.0.0.1:32106',
  sessionId: 'avatar-channel-session',
  wechatPluginEndpoint: 'http://127.0.0.1:8781',
}

function restoreDefaultConfig() {
  setConfig({ endpoint: DEFAULT_ENDPOINT })
}

describe('global sdk config', () => {
  afterEach(restoreDefaultConfig)

  test('endpoint is still required', () => {
    expect(() => setConfig({} as any)).toThrow('config key endpoint is required')
  })

  test('ships voice transport and display defaults without an installer', () => {
    expect(config()).toEqual({ endpoint: DEFAULT_ENDPOINT, voiceClient: DEFAULT_VOICE, show_turn_id: false })
  })

  test('accepts an optional voiceClient and exposes it via config()', () => {
    setConfig({
      endpoint: 'http://server:32101',
      voiceClient: { interaction_endpoint: 'https://127.0.0.1:8782', dh2d_endpoint: 'http://192.168.10.23:32107' },
    })
    expect(config()).toEqual({
      endpoint: 'http://server:32101',
      voiceClient: { interaction_endpoint: 'https://127.0.0.1:8782', dh2d_endpoint: 'http://192.168.10.23:32107' },
      show_turn_id: false,
    })
  })

  test('omitted voiceClient restores SDK defaults across setConfig calls', () => {
    setConfig({
      endpoint: 'http://server:32101',
      voiceClient: { interaction_endpoint: 'ws://client:8300', dh2d_endpoint: 'http://dh2d.voice:32107' },
    })
    // Each call resolves against SDK defaults, not the previous override.
    setConfig({ endpoint: 'http://other:32101' })
    expect(config()).toEqual({ endpoint: 'http://other:32101', voiceClient: DEFAULT_VOICE, show_turn_id: false })
  })
})
