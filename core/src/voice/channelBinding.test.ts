import {
  CHANNEL_BINDING_TOOL_NAME,
  createChannelBindingWorkflow,
  type ChannelBindingSnapshot,
  type VoiceClientToolCall,
} from './channelBinding'

function response(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
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

function toolCall(arguments_: Record<string, unknown> = {
  channel: 'wechat',
  action: 'initiate',
}): VoiceClientToolCall {
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

  test('accepts bind_channel cancellation locally without a backend request', async () => {
    const pending = deferred<Response>()
    const requests: { url: string, init?: RequestInit }[] = []
    const seen: ChannelBindingSnapshot[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init })
      if (init?.method === 'POST') return response(snapshot({ state: 'qr', qr_url: 'https://qr.example/value' }))
      return pending.promise
    }
    const workflow = createChannelBindingWorkflow({
      endpoint: 'http://127.0.0.1:8781',
      fetch: fetchImpl,
      onSnapshot: current => seen.push(current),
    })

    await expect(workflow.handleToolCall(toolCall())).resolves.toEqual({
      ok: true,
      result: { status: 'initiated' },
    })
    await expect(workflow.handleToolCall(toolCall({
      channel: 'wechat', action: 'cancel',
    }))).resolves.toEqual({ ok: true, result: { status: 'cancelled' } })
    expect(requests).toHaveLength(2)
    expect(requests[1].init?.method).toBeUndefined()
    expect(workflow.snapshot).toEqual(snapshot({
      state: 'cancelled', revision: 2, qr_url: null,
    }))
    expect(seen[seen.length - 1].state).toBe('cancelled')

    await expect(workflow.handleToolCall(toolCall({
      channel: 'wechat', action: 'cancel',
    }))).resolves.toEqual({ ok: true, result: { status: 'not_active' } })
    pending.resolve(response(snapshot({ state: 'bound', revision: 2 })))
    await flush()
    expect(workflow.snapshot?.state).toBe('cancelled')
    workflow.dispose()
  })

  test('dismisses a failed binding display through the ID-free cancel tool', async () => {
    const poll = deferred<Response>()
    const failedSeen = deferred<void>()
    const seen: ChannelBindingSnapshot[] = []
    const fetchImpl = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return response(snapshot({ state: 'qr', qr_url: 'https://qr.example/value' }))
      return poll.promise
    })
    const workflow = createChannelBindingWorkflow({
      endpoint: 'http://127.0.0.1:8781', fetch: fetchImpl,
      onSnapshot: current => {
        seen.push(current)
        if (current.state === 'failed') failedSeen.resolve()
      },
    })
    await workflow.handleToolCall(toolCall())
    poll.resolve(response(snapshot({ state: 'failed', revision: 2, error: 'login_failed' })))
    await failedSeen.promise
    fetchImpl.mockClear()

    await expect(workflow.handleToolCall(toolCall({ channel: 'wechat', action: 'cancel' })))
      .resolves.toEqual({ ok: true, result: { status: 'cancelled' } })
    expect(seen.map(current => current.state)).toEqual(['qr', 'failed', 'cancelled'])
    expect(seen[seen.length - 1]).toEqual(snapshot({ state: 'cancelled', revision: 3, error: null }))
    await expect(workflow.handleToolCall(toolCall({ channel: 'wechat', action: 'cancel' })))
      .resolves.toEqual({ ok: true, result: { status: 'not_active' } })
    expect(seen).toHaveLength(3)
    expect(fetchImpl).not.toHaveBeenCalled()
    workflow.dispose()
  })

  test('dismisses a failed binding display through explicit operation cancellation', async () => {
    const seen: ChannelBindingSnapshot[] = []
    const fetchImpl = jest.fn(async () => response(snapshot({ state: 'failed', error: 'login_failed' })))
    const workflow = createChannelBindingWorkflow({
      endpoint: 'http://127.0.0.1:8781', fetch: fetchImpl,
      onSnapshot: current => seen.push(current),
    })
    await workflow.handleToolCall(toolCall())
    fetchImpl.mockClear()
    expect(workflow.cancel('some-other-operation')).toBe(false)
    expect(seen.map(current => current.state)).toEqual(['failed'])
    expect(workflow.cancel('binding-1')).toBe(true)
    expect(seen.map(current => current.state)).toEqual(['failed', 'cancelled'])
    expect(workflow.snapshot).toEqual(snapshot({ state: 'cancelled', revision: 2, error: null }))
    expect(fetchImpl).not.toHaveBeenCalled()
    workflow.dispose()
  })

  test('fences verification completion after failed display dismissal', async () => {
    const verification = deferred<Response>()
    const poll = deferred<Response>()
    const failedSeen = deferred<void>()
    const seen: ChannelBindingSnapshot[] = []
    const workflow = createChannelBindingWorkflow({
      endpoint: 'http://127.0.0.1:8781',
      fetch: async (input, init) => {
        if (String(input).endsWith('/verify')) return verification.promise
        if (init?.method === 'POST') return response(snapshot({
          state: 'verification', verification: { required: true, retry: false },
        }))
        return poll.promise
      },
      onSnapshot: current => {
        seen.push(current)
        if (current.state === 'failed') failedSeen.resolve()
      },
    })
    await workflow.handleToolCall(toolCall())
    const pending = workflow.verify('synthetic-code')
    poll.resolve(response(snapshot({ state: 'failed', revision: 2, error: 'login_failed' })))
    await failedSeen.promise
    await expect(workflow.handleToolCall(toolCall({ channel: 'wechat', action: 'cancel' })))
      .resolves.toEqual({ ok: true, result: { status: 'cancelled' } })
    verification.resolve(response({ accepted: true }))
    await expect(pending).resolves.toEqual({ accepted: false })
    expect(seen.map(current => current.state)).toEqual(['verification', 'failed', 'cancelled'])
    workflow.dispose()
  })

  test('fences a verification response that completes after local cancellation', async () => {
    const verifyResponse = deferred<Response>()
    const monitorResponse = deferred<Response>()
    const seen: ChannelBindingSnapshot[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'POST' && url.endsWith('/bindings')) {
        return response(snapshot({
          state: 'verification',
          revision: 2,
          verification: { required: true, retry: false },
        }))
      }
      if (init?.method === 'POST' && url.endsWith('/verify')) return verifyResponse.promise
      if (url.includes('/bindings/binding-1')) return monitorResponse.promise
      throw new Error(`unexpected request ${url}`)
    }
    const workflow = createChannelBindingWorkflow({
      endpoint: 'http://127.0.0.1:8781',
      fetch: fetchImpl,
      onSnapshot: current => seen.push(current),
    })

    await workflow.handleToolCall(toolCall())
    const verifying = workflow.verify('123456')
    await expect(workflow.handleToolCall(toolCall({
      channel: 'wechat', action: 'cancel',
    }))).resolves.toEqual({ ok: true, result: { status: 'cancelled' } })

    verifyResponse.resolve(response({ accepted: true }))
    await expect(verifying).resolves.toEqual({ accepted: false })
    expect(workflow.snapshot?.state).toBe('cancelled')
    expect(seen.map(current => current.state)).toEqual(['verification', 'cancelled'])
    workflow.dispose()
    monitorResponse.resolve(response(snapshot({ state: 'bound', revision: 3 })))
    await flush()
  })

  test('explicit initiation may reactivate a locally dismissed operation', async () => {
    const firstMonitor = deferred<Response>()
    const secondMonitor = deferred<Response>()
    const requests: { url: string, init?: RequestInit }[] = []
    let postCount = 0
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, init })
      if (init?.method === 'POST' && url.endsWith('/bindings')) {
        postCount += 1
        return response(snapshot({
          state: 'qr',
          revision: postCount === 1 ? 1 : 3,
          qr_url: `https://qr.example/${postCount}`,
        }))
      }
      return postCount === 1 ? firstMonitor.promise : secondMonitor.promise
    }
    const workflow = createChannelBindingWorkflow({
      endpoint: 'http://127.0.0.1:8781',
      fetch: fetchImpl,
    })

    await workflow.handleToolCall(toolCall())
    await expect(workflow.handleToolCall(toolCall({
      channel: 'wechat', action: 'cancel',
    }))).resolves.toEqual({ ok: true, result: { status: 'cancelled' } })
    await workflow.handleToolCall(toolCall())

    expect(postCount).toBe(2)
    expect(workflow.snapshot).toEqual(snapshot({
      state: 'qr', revision: 3, qr_url: 'https://qr.example/2',
    }))
    const firstRequest = requests.find(request => request.url.includes('after_revision=1'))
    const secondRequest = requests.find(request => request.url.includes('after_revision=3'))
    expect((firstRequest?.init?.signal as AbortSignal).aborted).toBe(true)
    expect((secondRequest?.init?.signal as AbortSignal).aborted).toBe(false)
    workflow.dispose()
    firstMonitor.resolve(response(snapshot({ state: 'bound', revision: 2 })))
    secondMonitor.resolve(response(snapshot({ state: 'bound', revision: 4 })))
    await flush()
  })

  test.each([undefined, 'bound'] as const)('cancel with %s operation is a harmless local no-op', async state => {
    const fetchImpl = jest.fn(async () => response(snapshot({ state: state ?? 'bound' })))
    const workflow = createChannelBindingWorkflow({ endpoint: 'http://127.0.0.1:8781', fetch: fetchImpl })
    if (state) await workflow.handleToolCall(toolCall())
    const before = workflow.snapshot
    fetchImpl.mockClear()
    await expect(workflow.handleToolCall(toolCall({ channel: 'wechat', action: 'cancel' })))
      .resolves.toEqual({ ok: true, result: { status: 'not_active' } })
    expect(workflow.snapshot).toEqual(before)
    expect(fetchImpl).not.toHaveBeenCalled()
    workflow.dispose()
  })

  test('cancels a pending initiation before its POST completes', async () => {
    const post = deferred<Response>()
    const workflow = createChannelBindingWorkflow({
      endpoint: 'http://127.0.0.1:8781',
      fetch: async (_input, init) => init?.method === 'POST' ? post.promise : response({}),
    })
    const initiating = workflow.handleToolCall(toolCall())
    await flush()
    await expect(workflow.handleToolCall(toolCall({ channel: 'wechat', action: 'cancel' }))).resolves.toEqual({
      ok: true,
      result: { status: 'cancelled' },
    })
    post.resolve(response(snapshot({ state: 'initiating' })))
    await expect(initiating).resolves.toEqual({
      ok: false,
      error: { code: 'binding_unavailable', message: 'WeChat binding service unavailable' },
    })
    expect(workflow.snapshot).toBeUndefined()
    workflow.dispose()
  })

  test('cancels a pending initiation even when an older operation is current', async () => {
    const post = deferred<Response>()
    let posts = 0
    const seen: ChannelBindingSnapshot[] = []
    const workflow = createChannelBindingWorkflow({
      endpoint: 'http://127.0.0.1:8781',
      fetch: async (_input, init) => {
        if (init?.method !== 'POST') return response({})
        posts += 1
        return posts === 1
          ? response(snapshot({ state: 'failed', error: 'login_failed' }))
          : post.promise
      },
      onSnapshot: value => seen.push(value),
    })
    await expect(workflow.handleToolCall(toolCall())).resolves.toEqual({
      ok: true, result: { status: 'initiated' },
    })
    const pending = workflow.handleToolCall(toolCall())
    await flush()
    await expect(workflow.handleToolCall(toolCall({ channel: 'wechat', action: 'cancel' }))).resolves.toEqual({
      ok: true, result: { status: 'cancelled' },
    })
    expect(seen[seen.length - 1]?.state).toBe('cancelled')
    post.resolve(response(snapshot({ state: 'initiating' })))
    await expect(pending).resolves.toMatchObject({ ok: false })
    workflow.dispose()
  })

  test('synchronizes generation before retrying a stale initiation', async () => {
    const requests: { init?: RequestInit }[] = []
    let count = 0
    const workflow = createChannelBindingWorkflow({
      endpoint: 'http://127.0.0.1:8781',
      fetch: async (_input, init) => {
        requests.push({ init })
        count += 1
        if (count === 1) return response({ error: 'binding_generation_stale' }, 409, { 'x-binding-generation': '1' })
        if (count === 2) return response({ operation_status: 'idle', has_linked_account: false }, 200, { 'x-binding-generation': '1' })
        return response(snapshot({ state: 'initiating' }), 200, { 'x-binding-generation': '1' })
      },
    })
    await expect(workflow.handleToolCall(toolCall())).resolves.toEqual({
      ok: true, result: { status: 'initiated' },
    })
    expect(new Headers(requests[0]?.init?.headers).get('x-binding-generation')).toBe('0')
    expect(requests[1]?.init?.method).toBeUndefined()
    expect(new Headers(requests[2]?.init?.headers).get('x-binding-generation')).toBe('1')
    workflow.dispose()
  })

  test('queries sanitized binding status without an operation id', async () => {
    const requests: { url: string, init?: RequestInit }[] = []
    const workflow = createChannelBindingWorkflow({
      endpoint: 'http://127.0.0.1:8781',
      fetch: async (input, init) => {
        requests.push({ url: String(input), init })
        return response({ operation_status: 'waiting_for_scan', has_linked_account: true })
      },
    })

    await expect(workflow.handleToolCall(toolCall({ channel: 'wechat', action: 'status' }))).resolves.toEqual({
      ok: true,
      result: { operation_status: 'waiting_for_scan', has_linked_account: true },
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('http://127.0.0.1:8781/bindings')
    expect(requests[0]?.init).toMatchObject({ signal: expect.any(AbortSignal) })
    workflow.dispose()
  })

  test('unbinds the current binding through the backend', async () => {
    const requests: { url: string, init?: RequestInit }[] = []
    const workflow = createChannelBindingWorkflow({
      endpoint: 'http://127.0.0.1:8781',
      fetch: async (input, init) => {
        requests.push({ url: String(input), init })
        return response({ status: 'unbound' })
      },
    })

    await expect(workflow.handleToolCall(toolCall({ channel: 'wechat', action: 'unbind' }))).resolves.toEqual({
      ok: true,
      result: { status: 'unbound' },
    })
    expect(workflow.snapshot).toBeUndefined()
    expect(requests[0]).toMatchObject({
      url: 'http://127.0.0.1:8781/bindings',
      init: { method: 'DELETE' },
    })
    workflow.dispose()
  })

  test('reports no_bound_account_found when unbinding without a bound account', async () => {
    const workflow = createChannelBindingWorkflow({
      endpoint: 'http://127.0.0.1:8781',
      fetch: async () => response({ error: 'no_bound_account_found' }, 409),
    })

    await expect(workflow.handleToolCall(toolCall({ channel: 'wechat', action: 'unbind' }))).resolves.toEqual({
      ok: false,
      error: { code: 'no_bound_account_found', message: 'no_bound_account_found' },
    })
    workflow.dispose()
  })

  test('rejects invalid bind_channel action shapes', async () => {
    const fetchImpl = jest.fn(async () => response(snapshot({ revision: 1 })))
    const workflow = createChannelBindingWorkflow({
      endpoint: 'http://127.0.0.1:8781',
      fetch: fetchImpl,
    })

    await expect(workflow.handleToolCall(toolCall({ channel: 'wechat' }))).resolves.toEqual({
      ok: false,
      error: { code: 'invalid_arguments', message: 'invalid binding arguments' },
    })
    await expect(workflow.handleToolCall(toolCall({
      channel: 'wechat', action: 'cancel', operation_id: 'guessed-id',
    }))).resolves.toEqual({
      ok: false,
      error: { code: 'invalid_arguments', message: 'invalid binding arguments' },
    })
    await expect(workflow.handleToolCall({
      ...toolCall(), name: 'initiate_channel_binding',
    })).resolves.toBeUndefined()
    expect(fetchImpl).not.toHaveBeenCalled()
    workflow.dispose()
  })

  test('reuses one monitor when repeated initiation returns the same operation', async () => {
    const pending = deferred<Response>()
    let getCount = 0
    let postCount = 0
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'POST' && url.endsWith('/bindings')) {
        postCount += 1
        return response(snapshot({ operation_id: 'binding-1', revision: postCount }))
      }
      getCount += 1
      return pending.promise
    }
    const workflow = createChannelBindingWorkflow({
      endpoint: 'http://127.0.0.1:8781',
      fetch: fetchImpl,
    })

    await workflow.handleToolCall(toolCall())
    await workflow.handleToolCall(toolCall())
    expect(getCount).toBe(1)

    workflow.dispose()
    pending.resolve(response(snapshot({ operation_id: 'binding-1', state: 'bound', revision: 3 })))
    await flush()
  })

  test('rejects a monitor snapshot for a different operation', async () => {
    const errors: unknown[] = []
    const workflow = createChannelBindingWorkflow({
      endpoint: 'http://127.0.0.1:8781',
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') return response(snapshot({ operation_id: 'binding-1', revision: 1 }))
        return response(snapshot({ operation_id: 'binding-2', state: 'bound', revision: 2 }))
      },
      onError: error => errors.push(error),
    })

    await workflow.handleToolCall(toolCall())
    await flush()

    expect(errors).toEqual([{ code: 'binding_unavailable', message: 'WeChat binding service unavailable' }])
    expect(workflow.snapshot?.operation_id).toBe('binding-1')
    workflow.dispose()
  })

  test('aborts the superseded operation monitor when a new operation starts', async () => {
    const oldGet = deferred<Response>()
    const newGet = deferred<Response>()
    const requests: { url: string, init?: RequestInit }[] = []
    let postCount = 0
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, init })
      if (init?.method === 'POST' && url.endsWith('/bindings')) {
        postCount += 1
        return response(snapshot({ operation_id: `binding-${postCount}`, revision: 1 }))
      }
      if (url.includes('/bindings/binding-1')) return oldGet.promise
      return newGet.promise
    }
    const workflow = createChannelBindingWorkflow({
      endpoint: 'http://127.0.0.1:8781',
      fetch: fetchImpl,
    })

    await workflow.handleToolCall(toolCall())
    await workflow.handleToolCall(toolCall())

    const oldRequest = requests.find(request => request.url.includes('/bindings/binding-1'))
    const newRequest = requests.find(request => request.url.includes('/bindings/binding-2'))
    expect(oldRequest?.init?.signal).toBeDefined()
    expect((oldRequest?.init?.signal as AbortSignal).aborted).toBe(true)
    expect((newRequest?.init?.signal as AbortSignal).aborted).toBe(false)

    oldGet.resolve(response(snapshot({ operation_id: 'binding-1', state: 'bound', revision: 2 })))
    newGet.resolve(response(snapshot({ operation_id: 'binding-2', state: 'bound', revision: 2 })))
    await flush()
    workflow.dispose()
  })

  test('continues polling when a new initiation replaces an older operation', async () => {
    const firstGet = deferred<Response>()
    const secondGet = deferred<Response>()
    const requests: string[] = []
    const seen: ChannelBindingSnapshot[] = []
    let postCount = 0
    const boundSeen = deferred<void>()
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push(url)
      if (init?.method === 'POST' && url.endsWith('/bindings')) {
        postCount += 1
        return response(snapshot({
          operation_id: `binding-${postCount}`,
          revision: 1,
        }))
      }
      if (url.includes('/bindings/binding-1')) return firstGet.promise
      if (url.includes('/bindings/binding-2')) return secondGet.promise
      throw new Error(`unexpected request ${url}`)
    }
    const workflow = createChannelBindingWorkflow({
      endpoint: 'http://127.0.0.1:8781',
      fetch: fetchImpl,
      onSnapshot: current => {
        seen.push(current)
        if (current.operation_id === 'binding-2' && current.state === 'bound') boundSeen.resolve()
      },
    })

    await workflow.handleToolCall(toolCall())
    await workflow.handleToolCall(toolCall({ channel: 'wechat', action: 'initiate' }))
    expect(requests).toContain('http://127.0.0.1:8781/bindings/binding-2?after_revision=1')

    firstGet.resolve(response(snapshot({
      operation_id: 'binding-1',
      state: 'qr',
      revision: 2,
      qr_url: 'https://qr.example/old',
    })))
    secondGet.resolve(response(snapshot({
      operation_id: 'binding-2',
      state: 'bound',
      revision: 2,
    })))
    await boundSeen.promise

    expect(seen).toEqual([
      snapshot({ operation_id: 'binding-1', revision: 1 }),
      snapshot({ operation_id: 'binding-2', revision: 1 }),
      snapshot({ operation_id: 'binding-2', state: 'bound', revision: 2 }),
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

  test('ignores a verification result after its operation is replaced', async () => {
    const verificationResponse = deferred<Response>()
    const oldMonitor = deferred<Response>()
    let postCount = 0
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'POST' && url.endsWith('/bindings')) {
        postCount += 1
        return response(snapshot({
          operation_id: `binding-${postCount}`,
          state: postCount === 1 ? 'verification' : 'bound',
          revision: 1,
          verification: postCount === 1 ? { required: true, retry: false } : null,
        }))
      }
      if (init?.method === 'POST' && url.endsWith('/verify')) return verificationResponse.promise
      return oldMonitor.promise
    }
    const workflow = createChannelBindingWorkflow({
      endpoint: 'http://127.0.0.1:8781',
      fetch: fetchImpl,
    })

    await workflow.handleToolCall(toolCall())
    const verifying = workflow.verify('123456')
    await workflow.handleToolCall(toolCall())
    verificationResponse.resolve(response({ accepted: true }))
    oldMonitor.resolve(response(snapshot({ operation_id: 'binding-1', state: 'bound', revision: 2 })))

    await expect(verifying).resolves.toEqual({ accepted: false })
    await flush()
    workflow.dispose()
  })

  test('disposes transport and fences callbacks from a retired workflow', async () => {
    const pending = deferred<Response>()
    const seen: ChannelBindingSnapshot[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'POST' && url.endsWith('/bindings')) {
        return response(snapshot({ revision: 1 }))
      }
      return pending.promise
    }
    const workflow = createChannelBindingWorkflow({
      endpoint: 'http://127.0.0.1:8781',
      fetch: fetchImpl,
      onSnapshot: current => seen.push(current),
    })

    await workflow.handleToolCall(toolCall())
    workflow.dispose()
    pending.resolve(response(snapshot({ state: 'bound', revision: 2 })))
    await flush()

    expect(seen.map(current => current.state)).toEqual(['initiating'])
    await expect(workflow.verify('123456')).resolves.toEqual({ accepted: false })
    await expect(workflow.handleToolCall(toolCall())).resolves.toEqual({
      ok: false,
      error: { code: 'binding_unavailable', message: 'WeChat binding service unavailable' },
    })
  })

  test('does not report an in-flight verification failure after disposal', async () => {
    const verifyResponse = deferred<Response>()
    const monitorResponse = deferred<Response>()
    const errors: unknown[] = []
    let getCount = 0
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'POST' && url.endsWith('/bindings')) {
        return response(snapshot({ revision: 1 }))
      }
      if (init?.method === 'POST' && url.endsWith('/verify')) return verifyResponse.promise
      getCount += 1
      if (getCount > 1) return monitorResponse.promise
      return response(snapshot({
        state: 'verification',
        revision: 2,
        verification: { required: true, retry: false },
      }))
    }
    const workflow = createChannelBindingWorkflow({
      endpoint: 'http://127.0.0.1:8781',
      fetch: fetchImpl,
      onError: error => errors.push(error),
    })

    await workflow.handleToolCall(toolCall())
    await flush()
    expect(getCount).toBeGreaterThan(0)
    const verifying = workflow.verify('123456')
    workflow.dispose()
    verifyResponse.reject(new Error('aborted'))
    monitorResponse.resolve(response(snapshot({ state: 'bound', revision: 3 })))
    await expect(verifying).resolves.toEqual({ accepted: false })
    await flush()
    expect(errors).toEqual([])
  })

  test('rejects dot-segment operation ids before constructing polling paths', async () => {
    const requests: string[] = []
    const workflow = createChannelBindingWorkflow({
      endpoint: 'http://127.0.0.1:8781',
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(String(input))
        if (init?.method === 'POST') return response(snapshot({ operation_id: '..' }))
        return response(snapshot({ operation_id: '..', state: 'bound', revision: 2 }))
      },
    })

    await expect(workflow.handleToolCall(toolCall())).resolves.toEqual({
      ok: false,
      error: { code: 'binding_unavailable', message: 'WeChat binding service unavailable' },
    })
    expect(requests).toEqual(['http://127.0.0.1:8781/bindings'])
    workflow.dispose()
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
    await expect(workflow.handleToolCall(toolCall({
      channel: 'wechat', action: 'initiate', extra: true,
    }))).resolves.toEqual({
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
