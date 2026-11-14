import { abortable } from '../abortable'
import { config as rootConfig, setConfig } from '../config'
import { hooks } from '../hooks'
import { globalDH2DSessions, untilSessionCountLessThanOrEqualTo } from './hooks'
import { DH2DSessionConfig, ResolvedDH2DSessionConfig } from './types'

it('claims current shared capacity atomically and retires cancelled waiters', async () => {
  jest.useFakeTimers()
  const gate = untilSessionCountLessThanOrEqualTo(0)
  const old = {} as any, first = {} as any, second = {} as any, cancelled = {} as any
  const scopes = [abortable(), abortable(), abortable()]
  globalDH2DSessions.value = [old]
  const waits = [gate(first, scopes[0]), gate(second, scopes[1]), gate(cancelled, scopes[2])]
  try {
    globalDH2DSessions.value = []
    scopes[2].abort()
    await jest.advanceTimersByTimeAsync(1000)
    expect(globalDH2DSessions.value).toEqual([first])
    globalDH2DSessions.value = []
    await jest.advanceTimersByTimeAsync(1000)
    expect(globalDH2DSessions.value).toEqual([second])
    await Promise.all(waits)
    globalDH2DSessions.value = []
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    scopes.forEach(scope => scope.abort())
    await Promise.all(waits)
    globalDH2DSessions.value = []
    jest.useRealTimers()
  }
})

const DEFAULT_ENDPOINT = 'http://localhost:32101'

function restoreDefaultConfig() {
  setConfig({ endpoint: DEFAULT_ENDPOINT })
}

describe('dh2d defaultConfig voiceClient inheritance', () => {
  afterEach(restoreDefaultConfig)

  test('inherits voiceClient from the root config when the session config omits it', () => {
    setConfig({
      endpoint: 'http://server:32101',
      voiceClient: { interaction_endpoint: 'https://127.0.0.1:8782', dh2d_endpoint: 'http://192.168.10.23:32107' },
    })
    const resolved = hooks.dh2d.defaultConfig()
    expect(resolved.voiceClient).toEqual(rootConfig().voiceClient)
    expect(resolved.voiceClient?.interaction_endpoint).toBe('https://127.0.0.1:8782')
    expect(resolved.voiceClient?.dh2d_endpoint).toBe('http://192.168.10.23:32107')
  })

  test('an explicit session voiceClient overrides the root config', () => {
    setConfig({
      endpoint: 'http://server:32101',
      voiceClient: { interaction_endpoint: 'ws://global:8300', dh2d_endpoint: 'http://global-dh2d:32107' },
    })
    const resolved = hooks.dh2d.defaultConfig({
      voiceClient: { interaction_endpoint: 'ws://session:8300', dh2d_endpoint: 'http://session-dh2d:32107' },
    } as DH2DSessionConfig)
    expect(resolved.voiceClient).toEqual({ interaction_endpoint: 'ws://session:8300', dh2d_endpoint: 'http://session-dh2d:32107' })
  })

  test('uses SDK voice defaults when neither root nor session config provides it', () => {
    restoreDefaultConfig()
    const resolved = hooks.dh2d.defaultConfig({ videoId: 'xiaomai' })
    expect(resolved.voiceClient).toEqual({
      interaction_endpoint: 'http://127.0.0.1:8780',
      dh2d_endpoint: 'http://127.0.0.1:32106',
      sessionId: 'avatar-channel-session',
      wechatPluginEndpoint: 'http://127.0.0.1:8781',
    })
  })
})
