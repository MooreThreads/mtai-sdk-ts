import { connectPc } from './pc'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

it.each(['offer', 'local', 'fetch', 'json', 'remote'])('joins pending %s work and fences continuations after abort', async stage => {
  const pending = deferred<any>()
  const entered = deferred<void>()
  const controller = new AbortController()
  const originalFetch = globalThis.fetch
  const operation = (name: string, value: any) => jest.fn(async () => {
    if (stage === name) { entered.resolve(); return pending.promise }
    return value
  })
  const pc = {
    createOffer: operation('offer', {}), setLocalDescription: operation('local', undefined),
    setRemoteDescription: operation('remote', undefined), iceGatheringState: 'complete',
    localDescription: { type: 'offer', sdp: 'sdp' },
  }
  const json = operation('json', {})
  globalThis.fetch = operation('fetch', { json }) as any
  let settled = false
  const result = connectPc(pc as unknown as RTCPeerConnection, '/offer', controller.signal).catch((error: unknown) => error)
    .then((value: unknown) => { settled = true; return value })
  try {
    await entered.promise
    controller.abort()
    await Promise.resolve()
    expect(settled).toBe(false)
    pending.resolve(stage === 'fetch' ? { json } : {})
    expect(await result).toEqual(new Error('connection aborted'))
    if (stage === 'offer') expect(pc.setLocalDescription).not.toHaveBeenCalled()
    if (stage !== 'remote') expect(pc.setRemoteDescription).not.toHaveBeenCalled()
    if (stage === 'fetch') expect((globalThis.fetch as jest.Mock).mock.calls[0][1].signal).toBe(controller.signal)
  } finally { pending.resolve({ json }); await result; globalThis.fetch = originalFetch }
})

it('cancels ICE observation without starting HTTP work', async () => {
  const controller = new AbortController()
  const entered = deferred<void>()
  const listeners = new Set<() => void>()
  const pc = {
    createOffer: async () => ({}), setLocalDescription: async () => {}, iceGatheringState: 'gathering',
    addEventListener: (_: string, handler: () => void) => { listeners.add(handler); entered.resolve() },
    removeEventListener: (_: string, handler: () => void) => { listeners.delete(handler) },
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = jest.fn()
  let failure: unknown
  const result = connectPc(pc as unknown as RTCPeerConnection, '/offer', controller.signal).catch((error: unknown) => { failure = error })
  try {
    await entered.promise
    controller.abort()
    await Promise.resolve()
    await Promise.resolve()
    expect(listeners.size).toBe(0)
    await result
    expect(failure).toEqual(new Error('connection aborted'))
    expect(globalThis.fetch).not.toHaveBeenCalled()
  } finally {
    // Retire the original implementation's uncancellable ICE fixture on RED.
    pc.iceGatheringState = 'complete'
    listeners.forEach(handler => handler())
    await result
    globalThis.fetch = originalFetch
  }
})
