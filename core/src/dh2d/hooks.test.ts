import { config as rootConfig, setConfig } from '../config'
import { events } from '../events'
import { hooks } from '../hooks'
import { createDH2DSession } from './sessions'
import { createVoiceMessageAdapter } from '../voice/adapter'
import {
  VoiceClientConnection,
  connectVoiceClient,
  disconnectVoiceClient,
} from './voiceConnections'
import { DH2DSessionConfig, ResolvedDH2DSessionConfig } from './types'

const DEFAULT_ENDPOINT = 'http://localhost:32101'

function restoreDefaultConfig() {
  setConfig({ endpoint: DEFAULT_ENDPOINT })
}

function patchFetchLoggedIn() {
  const original = (globalThis as any).fetch
  ;(globalThis as any).fetch = async () => ({
    ok: true,
    json: async () => ({ logged_in: true }),
  })
  return () => {
    ;(globalThis as any).fetch = original
  }
}

function patchHooks() {
  const original = { ...hooks.dh2d }
  return {
    restore: () => {
      for (const key of Object.keys(original) as (keyof typeof original)[]) {
        ;(hooks.dh2d as any)[key] = (original as any)[key]
      }
    },
  }
}

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

async function waitUntil(predicate: () => boolean, message: string) {
  for (let i = 0; i < 100 && !predicate(); i++) {
    await flush()
  }
  if (!predicate()) {
    throw new Error(`timed out waiting for: ${message}`)
  }
}

function voiceConnectionFixture() {
  const evt = events<any>()
  const ws = { sent: [] as any[], closed: false, send(data: any) { this.sent.push(data) }, close() { this.closed = true } }
  const pc = { close() { this.closed = true }, closed: false }
  const adapter = createVoiceMessageAdapter({ sessionId: 'voice-1' })
  const connection = {
    ws,
    pc,
    get sessionId() { return 'canonical-avatar' },
    voice: adapter,
    stopPlayback: () => undefined,
    on: evt.on,
    off: evt.off,
  } as unknown as VoiceClientConnection
  return { connection, ws }
}

function patchSessionHooks(captureVoiceConfig: (config: ResolvedDH2DSessionConfig) => void) {
  const { restore } = patchHooks()
  const fixture = voiceConnectionFixture()
  const legacyConnectCalls: ResolvedDH2DSessionConfig[] = []
  const disposePlayer = jest.fn()
  hooks.dh2d.getOrCreatePlayer = () => ({ video: {}, dispose: disposePlayer } as any)
  hooks.dh2d.beforeConnectingSession = async () => undefined
  hooks.dh2d.connectVoiceClient = (async (_logger: any, _elements: any, config: ResolvedDH2DSessionConfig) => {
    captureVoiceConfig(config)
    return fixture.connection
  }) as typeof connectVoiceClient
  hooks.dh2d.connect = (async (_logger: any, _elements: any, config: ResolvedDH2DSessionConfig) => {
    legacyConnectCalls.push(config)
    throw new Error('legacy connect must not be used in voice-client mode')
  }) as any
  hooks.dh2d.disconnectVoiceClient = (async () => undefined) as typeof disconnectVoiceClient
  hooks.dh2d.untilFailed = ((_logger: any, _connection: any, _elements: any, _config: any, scope: any) =>
    new Promise<void>(resolve => scope.onabort(() => resolve()))) as any
  return {
    restore,
    legacyConnectCalls,
    disposePlayer,
    fixture,
  }
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

describe('createDH2DSession voice-client mode through global config', () => {
  afterEach(restoreDefaultConfig)

  test('default session uses voice transport and accepts the original config flow', async () => {
    const captured: ResolvedDH2DSessionConfig[] = []
    const patched = patchSessionHooks(config => captured.push(config))
    const fetchSpy = jest.fn(() => { throw new Error('default voice session must not require legacy login') })
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as any
    const session = createDH2DSession({} as HTMLElement, { videoId: 'xiaomai', audioInput: true })
    try {
      await waitUntil(() => session.status === 'connected', 'default voice connection')
      expect(captured[0].voiceClient?.sessionId).toBe('avatar-channel-session')
      expect(captured[0].audioInput).toBe(true)
      await session.config({ type: 'config', voice: 'legacy-voice' })
      expect(patched.fixture.ws.sent).toEqual([])
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(patched.legacyConnectCalls).toHaveLength(0)
    } finally {
      await session.close()
      patched.restore()
      globalThis.fetch = originalFetch
    }
  })

  test('enters voice-client mode from the global config alone', async () => {
    setConfig({
      endpoint: 'http://server:32101',
      voiceClient: { interaction_endpoint: 'wss://127.0.0.1:8782', dh2d_endpoint: 'http://dh2d.voice:32107' },
    })
    const restoreFetch = patchFetchLoggedIn()
    const captured: ResolvedDH2DSessionConfig[] = []
    const patched = patchSessionHooks(config => captured.push(config))
    try {
      const statuses: string[] = []
      const session = createDH2DSession({} as HTMLElement, { videoId: 'xiaomai' })
      session.on('statuschange', status => statuses.push(status))
      await waitUntil(() => statuses.includes('connected'), 'connected status')
      expect(patched.legacyConnectCalls).toHaveLength(0)
      expect(captured).toHaveLength(1)
      expect(captured[0].voiceClient).toEqual({ interaction_endpoint: 'wss://127.0.0.1:8782', dh2d_endpoint: 'http://dh2d.voice:32107' })
      await session.close()
      expect(patched.disposePlayer).toHaveBeenCalledTimes(1)
    } finally {
      patched.restore()
      restoreFetch()
    }
  })

  test('an explicit per-session voiceClient overrides the global config', async () => {
    setConfig({
      endpoint: 'http://server:32101',
      voiceClient: { interaction_endpoint: 'wss://127.0.0.1:8782', dh2d_endpoint: 'http://dh2d.voice:32107' },
    })
    const restoreFetch = patchFetchLoggedIn()
    const captured: ResolvedDH2DSessionConfig[] = []
    const patched = patchSessionHooks(config => captured.push(config))
    try {
      const statuses: string[] = []
      const session = createDH2DSession({} as HTMLElement, {
        videoId: 'xiaomai',
        voiceClient: { interaction_endpoint: 'ws://192.168.10.9:8300', dh2d_endpoint: 'http://192.168.10.9:32107', sessionId: 'session-voice' },
      })
      session.on('statuschange', status => statuses.push(status))
      await waitUntil(() => statuses.includes('connected'), 'connected status')
      expect(captured).toHaveLength(1)
      expect(captured[0].voiceClient).toEqual({ interaction_endpoint: 'ws://192.168.10.9:8300', dh2d_endpoint: 'http://192.168.10.9:32107', sessionId: 'session-voice' })
      await session.close()
    } finally {
      patched.restore()
      restoreFetch()
    }
  })

  test('stays in legacy mode when voiceClient is explicitly disabled', async () => {
    setConfig({ endpoint: DEFAULT_ENDPOINT, voiceClient: undefined })
    const restoreFetch = patchFetchLoggedIn()
    const captured: ResolvedDH2DSessionConfig[] = []
    let voiceConnectCalls = 0
    const { restore } = patchHooks()
    const fixture = voiceConnectionFixture()
    hooks.dh2d.getOrCreatePlayer = () => ({ video: {} } as any)
    hooks.dh2d.beforeConnectingSession = async () => undefined
    hooks.dh2d.connectVoiceClient = (async (_logger: any, _elements: any, config: ResolvedDH2DSessionConfig) => {
      voiceConnectCalls++
      captured.push(config)
      return fixture.connection
    }) as typeof connectVoiceClient
    hooks.dh2d.connect = (async () => fixture.connection) as any
    hooks.dh2d.disconnect = async () => undefined
    hooks.dh2d.untilFailed = ((_logger: any, _connection: any, _elements: any, _config: any, scope: any) =>
      new Promise<void>(resolve => scope.onabort(() => resolve()))) as any
    try {
      const statuses: string[] = []
      const session = createDH2DSession({} as HTMLElement, { videoId: 'xiaomai' })
      session.on('statuschange', status => statuses.push(status))
      await waitUntil(() => statuses.includes('connected'), 'connected status')
      expect(voiceConnectCalls).toBe(0)
      await session.close()
    } finally {
      restore()
      restoreFetch()
    }
  })
})
