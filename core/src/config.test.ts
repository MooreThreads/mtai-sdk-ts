import { config, setConfig } from './config'

const DEFAULT_ENDPOINT = 'http://localhost:32101'

function restoreDefaultConfig() {
  setConfig({ endpoint: DEFAULT_ENDPOINT })
}

describe('global sdk config', () => {
  afterEach(restoreDefaultConfig)

  test('endpoint is still required', () => {
    expect(() => setConfig({} as any)).toThrow('config key endpoint is required')
  })

  test('legacy defaults are preserved without voiceClient', () => {
    restoreDefaultConfig()
    expect(config()).toEqual({ endpoint: DEFAULT_ENDPOINT })
  })

  test('accepts an optional voiceClient and exposes it via config()', () => {
    setConfig({
      endpoint: 'http://server:32101',
      voiceClient: { url: 'https://127.0.0.1:8782' },
    })
    expect(config()).toEqual({
      endpoint: 'http://server:32101',
      voiceClient: { url: 'https://127.0.0.1:8782' },
    })
  })

  test('voiceClient stays optional across setConfig calls', () => {
    setConfig({ endpoint: 'http://server:32101', voiceClient: { url: 'ws://client:8300' } })
    // A later setConfig without voiceClient must not fail with a
    // "config key voiceClient is required" error and must drop the value.
    setConfig({ endpoint: 'http://other:32101' })
    expect(config()).toEqual({ endpoint: 'http://other:32101' })
  })
})
