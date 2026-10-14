export const CHANNEL_BINDING_TOOL_NAME = 'initiate_channel_binding' as const

const BINDING_STATES = new Set([
  'initiating',
  'qr',
  'scanned',
  'expired',
  'verification',
  'bound',
  'failed',
])

const TERMINAL_STATES = new Set(['bound', 'failed'])

type BindingState =
  | 'initiating'
  | 'qr'
  | 'scanned'
  | 'expired'
  | 'verification'
  | 'bound'
  | 'failed'

export type ChannelBindingSnapshot = {
  operation_id: string,
  state: BindingState,
  revision: number,
  qr_url: string | null,
  verification: { required: true, retry: boolean } | null,
  error?: 'login_failed' | null,
}

export type VoiceClientToolCall = {
  type: 'tool.call',
  session_id: string,
  turn_id: string,
  call_id: string,
  name: string,
  arguments: Record<string, unknown>,
}

export type ChannelBindingError = {
  code: string,
  message: string,
}

export type VoiceClientToolResult =
  | { ok: true, result: Record<string, unknown> }
  | { ok: false, error: ChannelBindingError }

export type VoiceClientToolHandler = (
  call: VoiceClientToolCall,
) => Promise<VoiceClientToolResult | undefined>

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

export type ChannelBindingWorkflowOptions = {
  /** Explicit application configuration; there is intentionally no default. */
  endpoint: string,
  fetch?: FetchLike,
  onSnapshot?: (snapshot: ChannelBindingSnapshot) => void,
  onError?: (error: ChannelBindingError) => void,
}

export type ChannelBindingWorkflow = {
  /** Handles only initiate_channel_binding; other tool calls return undefined. */
  handleToolCall: VoiceClientToolHandler,
  /** Submits a verification code to the current operation, without retaining it. */
  verify: (code: string) => Promise<{ accepted: boolean }>,
  /** Stops transport work and fences all future UI callbacks. */
  dispose: () => void,
  /** Latest sanitized snapshot observed by this workflow, if any. */
  readonly snapshot: ChannelBindingSnapshot | undefined,
}

export type ChannelBindingCallbacks = {
  onSnapshot?: (snapshot: ChannelBindingSnapshot) => void,
  onError?: (error: ChannelBindingError) => void,
  onWorkflow?: (workflow: ChannelBindingWorkflow) => void,
}

const SAFE_MESSAGES: Record<string, string> = {
  invalid_arguments: 'invalid binding arguments',
  invalid_request: 'WeChat binding request was invalid',
  unknown_operation: 'WeChat binding operation is no longer available',
  binding_unavailable: 'WeChat binding service unavailable',
}

function safeError(code: string): ChannelBindingError {
  return { code, message: SAFE_MESSAGES[code] || SAFE_MESSAGES.binding_unavailable }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isTerminal(state: BindingState): boolean {
  return TERMINAL_STATES.has(state)
}

function cloneSnapshot(snapshot: ChannelBindingSnapshot): ChannelBindingSnapshot {
  return {
    ...snapshot,
    verification: snapshot.verification ? { ...snapshot.verification } : null,
  }
}

function parseSnapshot(value: unknown): ChannelBindingSnapshot {
  if (!isRecord(value)
      || typeof value.operation_id !== 'string'
      || !value.operation_id
      || typeof value.state !== 'string'
      || !BINDING_STATES.has(value.state)
      || !Number.isInteger(value.revision)
      || (value.revision as number) < 0
      || (value.qr_url !== null && typeof value.qr_url !== 'string')) {
    throw new Error('invalid binding snapshot')
  }

  let verification: ChannelBindingSnapshot['verification'] = null
  if (value.verification !== null && value.verification !== undefined) {
    if (!isRecord(value.verification)
        || value.verification.required !== true
        || typeof value.verification.retry !== 'boolean') {
      throw new Error('invalid binding snapshot')
    }
    verification = { required: true, retry: value.verification.retry }
  }

  let error: ChannelBindingSnapshot['error']
  if ('error' in value) {
    if (value.error !== null && value.error !== 'login_failed') {
      throw new Error('invalid binding snapshot')
    }
    error = value.error as 'login_failed' | null
  }

  return {
    operation_id: value.operation_id,
    state: value.state as BindingState,
    revision: value.revision as number,
    qr_url: value.qr_url as string | null,
    verification,
    ...(error !== undefined ? { error } : {}),
  }
}

function endpointBase(endpoint: string): URL {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new Error('invalid binding endpoint')
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username
      || url.password
      || url.search
      || url.hash) {
    throw new Error('invalid binding endpoint')
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

function endpointPath(base: URL, path: string): string {
  return new URL(path.replace(/^\/+/, ''), base).toString()
}

function toolArgumentsAreValid(arguments_: unknown): arguments_ is { channel: 'wechat' } {
  return isRecord(arguments_)
    && Object.keys(arguments_).length === 1
    && arguments_.channel === 'wechat'
}

export function createChannelBindingWorkflow(
  options: ChannelBindingWorkflowOptions,
): ChannelBindingWorkflow {
  const base = endpointBase(options.endpoint)
  const fetchImpl = options.fetch ?? ((input, init) => {
    if (typeof globalThis.fetch !== 'function') {
      return Promise.reject(new Error('fetch is unavailable'))
    }
    return globalThis.fetch(input, init)
  })

  let current: ChannelBindingSnapshot | undefined
  let operationId: string | undefined
  let initiation: Promise<ChannelBindingSnapshot> | undefined
  let disposed = false
  const abortController = typeof AbortController === 'function' ? new AbortController() : undefined

  const reportSnapshot = (snapshot: ChannelBindingSnapshot) => {
    if (disposed) return
    const changed = operationId !== snapshot.operation_id
      || current === undefined
      || snapshot.revision > current.revision
    if (!changed) return
    operationId = snapshot.operation_id
    current = cloneSnapshot(snapshot)
    try {
      options.onSnapshot?.(cloneSnapshot(snapshot))
    } catch {
      // UI callbacks are observers; they cannot stop the transport workflow.
    }
  }

  const reportError = (error: ChannelBindingError) => {
    if (disposed) return
    try {
      options.onError?.(error)
    } catch {
      // UI callbacks are observers; they cannot create a second transport path.
    }
  }

  const requestJson = async (path: string | URL, init?: RequestInit): Promise<unknown> => {
    if (disposed) throw safeError('binding_unavailable')
    let response: Response
    try {
      response = await fetchImpl(
        path instanceof URL ? path : endpointPath(base, path),
        { ...init, ...(abortController ? { signal: abortController.signal } : {}) },
      )
    } catch {
      throw safeError('binding_unavailable')
    }
    if (!response.ok) {
      const code = response.status === 400
        ? 'invalid_request'
        : response.status === 404 ? 'unknown_operation' : 'binding_unavailable'
      throw safeError(code)
    }
    try {
      return await response.json()
    } catch {
      throw safeError('binding_unavailable')
    }
  }

  const getSnapshot = async (id: string, afterRevision?: number): Promise<ChannelBindingSnapshot> => {
    const url = new URL(endpointPath(base, `bindings/${encodeURIComponent(id)}`))
    if (afterRevision !== undefined) url.searchParams.set('after_revision', String(afterRevision))
    return parseSnapshot(await requestJson(url))
  }

  const monitorOperation = async (id: string, revision: number): Promise<void> => {
    let after = revision
    try {
      while (!disposed && operationId === id && current !== undefined && !isTerminal(current.state)) {
        const next = await getSnapshot(id, after)
        if (operationId !== id) return
        if (next.revision <= after && !isTerminal(next.state)) {
          throw safeError('binding_unavailable')
        }
        reportSnapshot(next)
        after = next.revision
        if (isTerminal(next.state)) return
      }
    } catch (error) {
      if (operationId !== id) return
      const safe = isRecord(error) && typeof error.code === 'string'
        && typeof error.message === 'string'
        ? { code: error.code, message: error.message }
        : safeError('binding_unavailable')
      reportError(safe)
    }
  }

  const ensureMonitoring = (snapshot: ChannelBindingSnapshot) => {
    if (disposed || isTerminal(snapshot.state)) return
    void monitorOperation(snapshot.operation_id, snapshot.revision)
  }

  const initiate = async (): Promise<ChannelBindingSnapshot> => {
    const value = await requestJson('bindings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const snapshot = parseSnapshot(value)
    if (disposed) throw safeError('binding_unavailable')
    reportSnapshot(snapshot)
    ensureMonitoring(snapshot)
    return cloneSnapshot(snapshot)
  }

  const startInitiation = (): Promise<ChannelBindingSnapshot> => {
    if (initiation !== undefined) return initiation
    const pending = initiate()
    const joined = pending.finally(() => {
      if (initiation === joined) initiation = undefined
    })
    initiation = joined
    return joined
  }

  const workflow: ChannelBindingWorkflow = {
    async handleToolCall(call) {
      if (call.name !== CHANNEL_BINDING_TOOL_NAME) return undefined
      if (disposed) return { ok: false, error: safeError('binding_unavailable') }
      if (!toolArgumentsAreValid(call.arguments)) {
        const channel = isRecord(call.arguments) ? call.arguments.channel : undefined
        if (channel !== undefined && channel !== 'wechat') {
          return {
            ok: false,
            error: { code: 'invalid_arguments', message: 'channel must be "wechat"' },
          }
        }
        return {
          ok: false,
          error: { code: 'invalid_arguments', message: SAFE_MESSAGES.invalid_arguments },
        }
      }
      try {
        await startInitiation()
        return { ok: true, result: { status: 'initiated' } }
      } catch (error) {
        const safe = isRecord(error) && typeof error.code === 'string'
          && typeof error.message === 'string'
          ? { code: error.code, message: error.message }
          : safeError('binding_unavailable')
        return { ok: false, error: safe }
      }
    },

    async verify(code) {
      if (disposed || typeof code !== 'string' || !code.trim()
          || operationId === undefined
          || current?.state !== 'verification') {
        return { accepted: false }
      }
      try {
        const value = await requestJson(
          `bindings/${encodeURIComponent(operationId)}/verify`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code: code.trim() }),
          },
        )
        if (!isRecord(value) || typeof value.accepted !== 'boolean') {
          reportError(safeError('binding_unavailable'))
          return { accepted: false }
        }
        return { accepted: value.accepted }
      } catch (error) {
        const safe = isRecord(error) && typeof error.code === 'string'
          && typeof error.message === 'string'
          ? { code: error.code, message: error.message }
          : safeError('binding_unavailable')
        reportError(safe)
        return { accepted: false }
      }
    },

    dispose() {
      if (disposed) return
      disposed = true
      operationId = undefined
      abortController?.abort()
    },
    get snapshot() {
      return current ? cloneSnapshot(current) : undefined
    },
  }
  return workflow
}

export function createChannelBindingToolHandler(
  options: ChannelBindingWorkflowOptions,
): { workflow: ChannelBindingWorkflow, handler: VoiceClientToolHandler } {
  const workflow = createChannelBindingWorkflow(options)
  return { workflow, handler: call => workflow.handleToolCall(call) }
}
