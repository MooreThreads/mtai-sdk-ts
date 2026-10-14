import {
  CHANNEL_BINDING_TOOL_NAME,
  createChannelBindingWorkflow,
  type ChannelBindingSnapshot,
  type VoiceClientToolCall,
} from './channelBinding'

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

function toolCall(arguments_: Record<string, unknown> = { channel: 'wechat' }): VoiceClientToolCall {
  return {
    type: 'tool.call',
    session_id: 'voice-1',
    turn_id: 'turn-1',
    call_id: 'call-1',
    name: CHANNEL_BINDING_TOOL_NAME,
    arguments: arguments_,
  }
}

function snapshot(overrides: Partial<ChannelBindingSnapshot>): ChannelBindingSnapshot {
  return {
    operation_id: 'binding-1',
    state: 'initiating',
    revision: 1,
    qr_url: null,
    verification: null,
    ...overrides,
  }
}

describe('createChannelBindingWorkflow', () => {
  test('returns initiated before QR retrieval and continues revision-driven UI updates', async () => {
    const requests: { url: string, init?: RequestInit }[] = []
    const qrResponse = deferred<Response>()
    const nextResponse = deferred<Response>()
    let getCount = 0
    const seen: ChannelBindingSnapshot[] = []
    const qrSeen = deferred<void>()
    const boundSeen = deferred<void>()
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, init })
      if (init?.method === 'POST' && url.endsWith('/bindings')) {
        return response(snapshot({ state: 'initiating', revision: 1 }))
      }
      if (url.includes('/bindings/binding-1')) {
        getCount += 1
        if (getCount === 1) return qrResponse.promise
        return nextResponse.promise
      }
      throw new Error(`unexpected request ${url}`)
    }
    const workflow = createChannelBindingWorkflow({
      endpoint: 'http://127.0.0.1:8781/',
      fetch: fetchImpl,
      onSnapshot: (current: ChannelBindingSnapshot) => {
        seen.push(current)
        if (current.state === 'qr') qrSeen.resolve()
        if (current.state === 'bound') boundSeen.resolve()
      },
    })

    const initiated = await workflow.handleToolCall(toolCall())
    expect(initiated).toEqual({ ok: true, result: { status: 'initiated' } })
    expect(requests[0]).toMatchObject({
      url: 'http://127.0.0.1:8781/bindings',
      init: { method: 'POST' },
    })

    qrResponse.resolve(response(snapshot({ state: 'qr', revision: 2, qr_url: 'https://qr.example/value' })))
    await qrSeen.promise
    expect(seen).toEqual([
      snapshot({ state: 'initiating', revision: 1 }),
      snapshot({ state: 'qr', revision: 2, qr_url: 'https://qr.example/value' }),
    ])

    nextResponse.resolve(response(snapshot({ state: 'bound', revision: 3 })))
    await boundSeen.promise
    expect(seen[seen.length - 1]).toEqual(snapshot({ state: 'bound', revision: 3 }))
    expect(requests.map(request => request.url)).toEqual([
      'http://127.0.0.1:8781/bindings',
      'http://127.0.0.1:8781/bindings/binding-1?after_revision=1',
      'http://127.0.0.1:8781/bindings/binding-1?after_revision=2',
    ])
  })

  test('verification is a direct API callback and never enters the tool result', async () => {
    const requests: { url: string, init?: RequestInit }[] = []
    const verification = snapshot({
      state: 'verification',
      revision: 2,
      verification: { required: true, retry: false },
    })
    const bound = snapshot({ state: 'bound', revision: 3 })
    const boundWait = deferred<Response>()
    let getCount = 0
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, init })
      if (init?.method === 'POST' && url.endsWith('/bindings')) return response(snapshot({ revision: 1 }))
      if (init?.method === 'POST' && url.endsWith('/verify')) return response({ accepted: true })
      if (url.includes('/bindings/binding-1')) {
        getCount += 1
        return getCount === 1 ? response(verification) : boundWait.promise
      }
      throw new Error(`unexpected request ${url}`)
    }
    const seen: ChannelBindingSnapshot[] = []
    const boundSeen = deferred<void>()
    const workflow = createChannelBindingWorkflow({
      endpoint: 'http://127.0.0.1:8781',
      fetch: fetchImpl,
      onSnapshot: (current: ChannelBindingSnapshot) => {
        seen.push(current)
        if (current.state === 'bound') boundSeen.resolve()
      },
    })

    await workflow.handleToolCall(toolCall())
    await flush()
    expect(seen[seen.length - 1]).toEqual(verification)

    const verified = await workflow.verify(' 123456 ')
    expect(verified).toEqual({ accepted: true })
    expect(requests[requests.length - 1]).toMatchObject({
      url: 'http://127.0.0.1:8781/bindings/binding-1/verify',
      init: {
        method: 'POST',
        body: JSON.stringify({ code: '123456' }),
      },
    })
    expect(JSON.stringify(seen)).not.toContain('123456')

    boundWait.resolve(response(bound))
    await boundSeen.promise
    expect(seen[seen.length - 1]).toEqual(bound)
  })

  test('rejects malformed channel arguments and reports fetch failure safely', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error('credential-bearing transport failure')
    })
    const workflow = createChannelBindingWorkflow({
      endpoint: 'http://127.0.0.1:8781',
      fetch: fetchImpl,
    })

    await expect(workflow.handleToolCall(toolCall({ channel: 'feishu' }))).resolves.toEqual({
      ok: false,
      error: { code: 'invalid_arguments', message: 'channel must be "wechat"' },
    })
    await expect(workflow.handleToolCall(toolCall({ channel: 'wechat', extra: true }))).resolves.toEqual({
      ok: false,
      error: { code: 'invalid_arguments', message: 'invalid binding arguments' },
    })
    await expect(workflow.handleToolCall(toolCall())).resolves.toEqual({
      ok: false,
      error: { code: 'binding_unavailable', message: 'WeChat binding service unavailable' },
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
