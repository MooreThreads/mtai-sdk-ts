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
  hooks.dh2d.getOrCreatePlayer = () => ({ video: {} } as any)
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
  hooks.dh2d.untilFailed = ((_logger: any, _connection: any, _elements: any, _config: any, _seq: any, _cb: any, scope: any) =>
    new Promise<void>(resolve => scope.onabort(() => resolve()))) as any
  return {
    restore,
    legacyConnectCalls,
    fixture,
  }
}

describe('dh2d defaultConfig voiceClient inheritance', () => {
  afterEach(restoreDefaultConfig)

  test('inherits voiceClient from the root config when the session config omits it', () => {
    setConfig({ endpoint: 'http://server:32101', voiceClient: { url: 'https://127.0.0.1:8782' } })
    const resolved = hooks.dh2d.defaultConfig()
    expect(resolved.voiceClient).toEqual(rootConfig().voiceClient)
    expect(resolved.voiceClient?.url).toBe('https://127.0.0.1:8782')
  })

  test('an explicit session voiceClient overrides the root config', () => {
    setConfig({ endpoint: 'http://server:32101', voiceClient: { url: 'ws://global:8300' } })
    const resolved = hooks.dh2d.defaultConfig({ voiceClient: { url: 'ws://session:8300' } } as DH2DSessionConfig)
    expect(resolved.voiceClient).toEqual({ url: 'ws://session:8300' })
  })

  test('voiceClient stays unset when neither root nor session config provides it', () => {
    restoreDefaultConfig()
    const resolved = hooks.dh2d.defaultConfig({ videoId: 'xiaomai' })
    expect(resolved.voiceClient).toBeUndefined()
  })
})

describe('createDH2DSession voice-client mode through global config', () => {
  afterEach(restoreDefaultConfig)

  test('enters voice-client mode from the global config alone', async () => {
    setConfig({ endpoint: 'http://server:32101', voiceClient: { url: 'wss://127.0.0.1:8782' } })
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
      expect(captured[0].voiceClient).toEqual({ url: 'wss://127.0.0.1:8782' })
      await session.close()
    } finally {
      patched.restore()
      restoreFetch()
    }
  })

  test('an explicit per-session voiceClient overrides the global config', async () => {
    setConfig({ endpoint: 'http://server:32101', voiceClient: { url: 'wss://127.0.0.1:8782' } })
    const restoreFetch = patchFetchLoggedIn()
    const captured: ResolvedDH2DSessionConfig[] = []
    const patched = patchSessionHooks(config => captured.push(config))
    try {
      const statuses: string[] = []
      const session = createDH2DSession({} as HTMLElement, {
        videoId: 'xiaomai',
        voiceClient: { url: 'ws://192.168.10.9:8300', sessionId: 'session-voice' },
      })
      session.on('statuschange', status => statuses.push(status))
      await waitUntil(() => statuses.includes('connected'), 'connected status')
      expect(captured).toHaveLength(1)
      expect(captured[0].voiceClient).toEqual({ url: 'ws://192.168.10.9:8300', sessionId: 'session-voice' })
      await session.close()
    } finally {
      patched.restore()
      restoreFetch()
    }
  })

  test('stays in legacy mode when the global config has no voiceClient', async () => {
    restoreDefaultConfig()
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
    hooks.dh2d.untilFailed = ((_logger: any, _connection: any, _elements: any, _config: any, _seq: any, _cb: any, scope: any) =>
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
