import { abortable } from '../abortable'
import { events } from '../events'
import { hooks } from '../hooks'
import { createDH2DSession } from './sessions'
import { createVoiceMessageAdapter } from '../voice/adapter'
import { VoiceClientConnection, connectVoiceClient, disconnectVoiceClient } from './voiceConnections'

class FakeWebSocket {
  readonly sent: any[] = []
  closed = false
  send(data: any) { this.sent.push(data) }
  close() { this.closed = true }
}

class FakeEventTargetForPc {
  close() { this.closed = true }
  closed = false
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

function voiceConnectionFixture(withVoice = true) {
  const evt = events<any>()
  const ws = new FakeWebSocket()
  const pc = new FakeEventTargetForPc()
  const adapter = createVoiceMessageAdapter({ sessionId: 'voice-1' })
  const stopPlayback = jest.fn()
  const connection = {
    ws,
    pc,
    get sessionId() { return 'canonical-avatar' },
    ...(withVoice ? { voice: adapter, stopPlayback } : {}),
    on: evt.on,
    off: evt.off,
  } as unknown as VoiceClientConnection & { emit: typeof evt.emit }
  return { connection, ws, adapter, stopPlayback, emit: evt.emit }
}

describe('createDH2DSession login gate', () => {
  function patchFetch(body: () => unknown) {
    const original = (globalThis as any).fetch
    let fetchCalls = 0
    ;(globalThis as any).fetch = async () => {
      fetchCalls++
      return body()
    }
    return {
      calls: () => fetchCalls,
      restore: () => {
        ;(globalThis as any).fetch = original
      },
    }
  }

  function controllableUntilFailed() {
    const pending: ((_: void) => void)[] = []
    const hook = jest.fn(() => new Promise<void>(resolve => {
      pending.push(resolve)
    }))
    return {
      hook: hook as any,
      failCurrentConnection: () => pending.shift()?.(),
    }
  }

  function patchSessionHooks(opts: {
    voiceClientMode: boolean,
    untilFailedHook: any,
  }) {
    const { restore: restoreHooks } = patchHooks()
    const fixture = voiceConnectionFixture(!opts.voiceClientMode ? false : true)
    const connections: any[] = []
    let legacyConnectCalls = 0
    let voiceConnectCalls = 0
    hooks.dh2d.getOrCreatePlayer = () => ({ video: {} } as any)
    hooks.dh2d.beforeConnectingSession = async () => undefined
    hooks.dh2d.connectVoiceClient = (async () => {
      voiceConnectCalls++
      connections.push(fixture.connection)
      return fixture.connection
    }) as typeof connectVoiceClient
    hooks.dh2d.connect = (async () => {
      legacyConnectCalls++
      connections.push(fixture.connection)
      return fixture.connection
    }) as any
    hooks.dh2d.disconnect = async () => undefined
    hooks.dh2d.disconnectVoiceClient = async () => undefined
    hooks.dh2d.untilFailed = opts.untilFailedHook
    return {
      restore: restoreHooks,
      fixture,
      voiceConnectCalls: () => voiceConnectCalls,
      legacyConnectCalls: () => legacyConnectCalls,
    }
  }

  test('voice-client mode skips the login gate when /api/v1/logged_in is gone', async () => {
    // The obsolete ai-service login endpoint must not even be requested in
    // voice-client mode; a definitive logged-out answer must not stop the
    // session either, because the voice client owns its own authentication.
    const fetchMock = patchFetch(() => ({ ok: true, json: async () => ({ logged_in: false }) }))
    const untilFailed = controllableUntilFailed()
    const patched = patchSessionHooks({ voiceClientMode: true, untilFailedHook: untilFailed.hook })
    try {
      const statuses: string[] = []
      const session = createDH2DSession({} as HTMLElement, {
        videoId: 'xiaomai',
        voiceClient: { url: 'ws://client:8300' },
      })
      session.on('statuschange', status => statuses.push(status))
      await waitUntil(() => statuses.includes('connected'), 'connected status without a login check')
      expect(patched.voiceConnectCalls()).toBe(1)
      expect(fetchMock.calls()).toBe(0)
      await session.close()
    } finally {
      patched.restore()
      fetchMock.restore()
    }
  })

  test('voice-client mode skips the login gate on reconnect', async () => {
    // Even a definitive logged-out answer must not stop a voice-client
    // session from reconnecting: the client owns its own authentication.
    const fetchMock = patchFetch(() => ({ ok: true, json: async () => ({ logged_in: false }) }))
    const untilFailed = controllableUntilFailed()
    const patched = patchSessionHooks({ voiceClientMode: true, untilFailedHook: untilFailed.hook })
    try {
      const statuses: string[] = []
      const session = createDH2DSession({} as HTMLElement, {
        videoId: 'xiaomai',
        voiceClient: { url: 'ws://client:8300' },
      })
      session.on('statuschange', status => statuses.push(status))
      await waitUntil(() => statuses.includes('connected'), 'first connected status')
      untilFailed.failCurrentConnection()
      await waitUntil(
        () => statuses.filter(_ => _ === 'connected').length === 2,
        'reconnected status without a login check',
      )
      expect(statuses).toContain('reconnecting')
      expect(patched.voiceConnectCalls()).toBe(2)
      expect(fetchMock.calls()).toBe(0)
      await session.close()
    } finally {
      patched.restore()
      fetchMock.restore()
    }
  })

  test('legacy mode still fails before connecting when not logged in', async () => {
    const fetchMock = patchFetch(() => ({ ok: true, json: async () => ({ logged_in: false }) }))
    const untilFailed = controllableUntilFailed()
    const patched = patchSessionHooks({ voiceClientMode: false, untilFailedHook: untilFailed.hook })
    try {
      const statuses: string[] = []
      const session = createDH2DSession({} as HTMLElement, { videoId: 'liruyun' })
      session.on('statuschange', status => statuses.push(status))
      await waitUntil(() => statuses.includes('failed'), 'failed status when logged out')
      expect(patched.legacyConnectCalls()).toBe(0)
      expect(fetchMock.calls()).toBe(1)
      await session.close()
    } finally {
      patched.restore()
      fetchMock.restore()
    }
  })

  test('legacy mode still requires login again on reconnect', async () => {
    let loggedIn = true
    const fetchMock = patchFetch(() => ({ ok: true, json: async () => ({ logged_in: loggedIn }) }))
    const untilFailed = controllableUntilFailed()
    const patched = patchSessionHooks({ voiceClientMode: false, untilFailedHook: untilFailed.hook })
    try {
      const statuses: string[] = []
      const session = createDH2DSession({} as HTMLElement, { videoId: 'liruyun' })
      session.on('statuschange', status => statuses.push(status))
      await waitUntil(() => statuses.includes('connected'), 'first connected status')
      loggedIn = false
      untilFailed.failCurrentConnection()
      await waitUntil(() => statuses.includes('failed'), 'failed status after logout during reconnect')
      expect(statuses).toContain('reconnecting')
      expect(patched.legacyConnectCalls()).toBe(1)
      expect(fetchMock.calls()).toBe(2)
      await session.close()
    } finally {
      patched.restore()
      fetchMock.restore()
    }
  })
})

describe('createDH2DSession voice-client mode', () => {
  test('uses the voice client connection hook and emits connected status', async () => {
    const restoreFetch = patchFetchLoggedIn()
    const { restore: restoreHooks } = patchHooks()
    const fixture = voiceConnectionFixture()
    let voiceConnectCalls = 0
    let voiceDisconnectCalls = 0
    let legacyConnectCalls = 0
    hooks.dh2d.getOrCreatePlayer = () => ({ video: {} } as any)
    hooks.dh2d.beforeConnectingSession = async () => undefined
    hooks.dh2d.connectVoiceClient = (async () => {
      voiceConnectCalls++
      return fixture.connection
    }) as typeof connectVoiceClient
    hooks.dh2d.connect = (async () => {
      legacyConnectCalls++
      throw new Error('legacy connect must not be used in voice-client mode')
    }) as any
    hooks.dh2d.disconnectVoiceClient = (async () => {
      voiceDisconnectCalls++
      fixture.stopPlayback()
    }) as typeof disconnectVoiceClient
    hooks.dh2d.untilFailed = ((_logger: any, _connection: any, _elements: any, _config: any, _seq: any, _cb: any, scope: any) =>
      new Promise<void>(resolve => scope.onabort(() => resolve()))) as any
    try {
      const statuses: string[] = []
      const messages: any[] = []
      const session = createDH2DSession({} as HTMLElement, {
        videoId: 'xiaomai',
        voiceClient: { url: 'ws://client:8300' },
      })
      session.on('statuschange', status => statuses.push(status))
      session.on('message', message => messages.push(message))

      await waitUntil(() => statuses.includes('connected'), 'connected status')
      expect(voiceConnectCalls).toBe(1)
      expect(legacyConnectCalls).toBe(0)

      fixture.emit('message', { type: 'status_change', status: 'listening' })
      await flush()
      expect(messages).toEqual([{ type: 'status_change', status: 'listening' }])

      await session.send({ type: 'wakeup' })
      expect(fixture.ws.sent.map(d => JSON.parse(d))).toEqual([
        { type: 'conversation.start', session_id: 'voice-1' },
      ])

      await session.close()
      expect(voiceDisconnectCalls).toBeGreaterThanOrEqual(1)
      expect(fixture.stopPlayback).toHaveBeenCalled()
      expect(statuses[statuses.length - 1]).toBe('closed')
    } finally {
      restoreHooks()
      restoreFetch()
    }
  })

  test('legacy mode is unchanged when voiceClient is not configured', async () => {
    const restoreFetch = patchFetchLoggedIn()
    const { restore: restoreHooks } = patchHooks()
    const fixture = voiceConnectionFixture(false)
    let voiceConnectCalls = 0
    let legacyConnectCalls = 0
    hooks.dh2d.getOrCreatePlayer = () => ({ video: {} } as any)
    hooks.dh2d.beforeConnectingSession = async () => undefined
    hooks.dh2d.connectVoiceClient = (async () => {
      voiceConnectCalls++
      throw new Error('voice connect must not be used without voiceClient config')
    }) as typeof connectVoiceClient
    hooks.dh2d.connect = (async () => {
      legacyConnectCalls++
      return fixture.connection
    }) as any
    hooks.dh2d.disconnect = async () => undefined
    hooks.dh2d.untilFailed = ((_logger: any, _connection: any, _elements: any, _config: any, _seq: any, _cb: any, scope: any) =>
      new Promise<void>(resolve => scope.onabort(() => resolve()))) as any
    try {
      const statuses: string[] = []
      const session = createDH2DSession({} as HTMLElement, { videoId: 'xiaomai' })
      session.on('statuschange', status => statuses.push(status))
      await waitUntil(() => statuses.includes('connected'), 'connected status')
      expect(legacyConnectCalls).toBe(1)
      expect(voiceConnectCalls).toBe(0)

      // Legacy JSON protocol messages pass through untranslated.
      await session.send({ type: 'input', text: 'hello' })
      expect(fixture.ws.sent.map(d => JSON.parse(d))).toEqual([
        { type: 'input', text: 'hello' },
      ])
      await session.close()
    } finally {
      restoreHooks()
      restoreFetch()
    }
  })
})

void abortable
