export const CHANNEL_BINDING_TOOL_NAME = 'bind_channel' as const

export type ChannelBindingAction = 'initiate' | 'cancel' | 'status' | 'unbind'

export type ChannelBindingStatus = {
  operation_status: 'idle' | 'starting' | 'waiting_for_scan' | 'awaiting_verification' | 'completed' | 'failed' | 'cancelled',
  has_linked_account: boolean,
}

const BINDING_STATES = new Set([
  'initiating',
  'qr',
  'scanned',
  'expired',
  'verification',
  'bound',
  'failed',
  'cancelled',
])

const TERMINAL_STATES = new Set(['bound', 'failed', 'cancelled'])

type BindingState =
  | 'initiating'
  | 'qr'
  | 'scanned'
  | 'expired'
  | 'verification'
  | 'bound'
  | 'failed'
  | 'cancelled'

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
  /** Handles only bind_channel; other tool calls return undefined. */
  handleToolCall: VoiceClientToolHandler,
  /** Submits a verification code to the current operation, without retaining it. */
  verify: (code: string) => Promise<{ accepted: boolean }>,
  /** Locally hides/fences one operation; it does not cancel backend login. */
  cancel: (operationId: string) => boolean,
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
  binding_generation_stale: 'WeChat binding service unavailable',
  no_bound_account_found: 'no_bound_account_found',
}

function safeError(code: string): ChannelBindingError {
  return { code, message: SAFE_MESSAGES[code] || SAFE_MESSAGES.binding_unavailable }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseBindingStatus(value: unknown): ChannelBindingStatus {
  const statuses = new Set([
    'idle', 'starting', 'waiting_for_scan', 'awaiting_verification',
    'completed', 'failed', 'cancelled',
  ])
  if (!isRecord(value)
      || typeof value.operation_status !== 'string'
      || !statuses.has(value.operation_status)
      || typeof value.has_linked_account !== 'boolean') {
    throw new Error('invalid binding status')
  }
  return {
    operation_status: value.operation_status as ChannelBindingStatus['operation_status'],
    has_linked_account: value.has_linked_account,
  }
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
      || value.operation_id === '.'
      || value.operation_id === '..'
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

type ChannelBindingArguments = { channel: 'wechat', action: ChannelBindingAction }

function toolArgumentsAreValid(arguments_: unknown): arguments_ is ChannelBindingArguments {
  if (!isRecord(arguments_) || arguments_.channel !== 'wechat'
      || !['initiate', 'cancel', 'status', 'unbind'].includes(arguments_.action as string)) return false
  return Object.keys(arguments_).length === 2
}

function invalidArgumentsError(arguments_: unknown): ChannelBindingError {
  if (isRecord(arguments_) && arguments_.channel !== undefined && arguments_.channel !== 'wechat') {
    return { code: 'invalid_arguments', message: 'channel must be "wechat"' }
  }
  return { code: 'invalid_arguments', message: SAFE_MESSAGES.invalid_arguments }
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
  let operationGeneration = 0
  let initiation: Promise<ChannelBindingSnapshot> | undefined
  let initiationController: AbortController | undefined
  const monitors = new Map<string, Promise<void>>()
  const operationControllers = new Map<string, AbortController>()
  let disposed = false
  let serverGeneration = 0
  const workflowAbortController = typeof AbortController === 'function' ? new AbortController() : undefined

  const reportSnapshot = (snapshot: ChannelBindingSnapshot) => {
    if (disposed) return
    const reactivatingLocallyCancelled = current?.state === 'cancelled'
      && snapshot.operation_id === operationId
      && snapshot.state !== 'cancelled'
    const changed = operationId !== snapshot.operation_id
      || current === undefined
      || snapshot.revision > current.revision
      || reactivatingLocallyCancelled
    if (!changed) return
    if (operationId !== snapshot.operation_id) {
      if (operationId !== undefined) {
        operationControllers.get(operationId)?.abort()
        operationControllers.delete(operationId)
        monitors.delete(operationId)
      }
      operationId = snapshot.operation_id
      operationGeneration += 1
      if (typeof AbortController === 'function') {
        operationControllers.set(snapshot.operation_id, new AbortController())
      }
    } else if (reactivatingLocallyCancelled) {
      operationGeneration += 1
      operationControllers.delete(snapshot.operation_id)
      if (typeof AbortController === 'function') {
        operationControllers.set(snapshot.operation_id, new AbortController())
      }
    } else if (typeof AbortController === 'function' && !operationControllers.has(snapshot.operation_id)) {
      operationControllers.set(snapshot.operation_id, new AbortController())
    }
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

  const requestJson = async (
    path: string | URL,
    init?: RequestInit,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    if (disposed) throw safeError('binding_unavailable')
    let response: Response
    const method = init?.method?.toUpperCase()
    try {
      const requestSignal = signal ?? workflowAbortController?.signal
      const headers = new Headers(init?.headers)
      if (serverGeneration !== undefined && (method === 'POST' || method === 'DELETE')) {
        headers.set('X-Binding-Generation', String(serverGeneration))
      }
      const requestInit = requestSignal
        ? { ...init, headers, signal: requestSignal }
        : { ...init, headers }
      response = await fetchImpl(
        path instanceof URL ? path : endpointPath(base, path),
        requestInit,
      )
      const reportedGeneration = response.headers?.get('x-binding-generation')
      if (reportedGeneration !== null && reportedGeneration !== undefined && /^\d+$/.test(reportedGeneration)) {
        const parsedGeneration = Number(reportedGeneration)
        if (Number.isSafeInteger(parsedGeneration)) {
          serverGeneration = method === 'POST' || method === 'DELETE'
            ? Math.max(serverGeneration, parsedGeneration) : parsedGeneration
        }
      }
    } catch {
      throw safeError('binding_unavailable')
    }
    if (!response.ok) {
      let body: unknown
      try { body = await response.json() } catch { /* use the status fallback */ }
      const reported = isRecord(body) && typeof body.error === 'string' ? body.error : undefined
      const code = reported === 'binding_generation_stale' ? reported
        : reported === 'no_bound_account_found' ? reported
        : response.status === 400 ? 'invalid_request'
          : response.status === 404 ? 'unknown_operation' : 'binding_unavailable'
      throw safeError(code)
    }
    try {
      return await response.json()
    } catch {
      throw safeError('binding_unavailable')
    }
  }

  const getSnapshot = async (
    id: string,
    afterRevision?: number,
    signal?: AbortSignal,
  ): Promise<ChannelBindingSnapshot> => {
    const url = new URL(endpointPath(base, `bindings/${encodeURIComponent(id)}`))
    if (afterRevision !== undefined) url.searchParams.set('after_revision', String(afterRevision))
    return parseSnapshot(await requestJson(url, undefined, signal))
  }

  const monitorOperation = async (
    id: string,
    revision: number,
    generation: number,
    signal?: AbortSignal,
  ): Promise<void> => {
    let after = revision
    try {
      while (!disposed
          && operationId === id
          && operationGeneration === generation
          && current !== undefined
          && !isTerminal(current.state)) {
        const next = await getSnapshot(id, after, signal)
        if (operationId !== id || operationGeneration !== generation) return
        if (next.operation_id !== id) {
          throw safeError('binding_unavailable')
        }
        if (next.revision <= after && !isTerminal(next.state)) {
          throw safeError('binding_unavailable')
        }
        reportSnapshot(next)
        after = next.revision
        if (isTerminal(next.state)) return
      }
    } catch (error) {
      if (disposed || operationId !== id || operationGeneration !== generation) return
      const safe = isRecord(error) && typeof error.code === 'string'
        && typeof error.message === 'string'
        ? { code: error.code, message: error.message }
        : safeError('binding_unavailable')
      reportError(safe)
    }
  }

  const ensureMonitoring = (snapshot: ChannelBindingSnapshot) => {
    if (disposed || isTerminal(snapshot.state) || monitors.has(snapshot.operation_id)) return
    const id = snapshot.operation_id
    const controller = operationControllers.get(id)
    const pending = monitorOperation(id, snapshot.revision, operationGeneration, controller?.signal)
    const tracked = pending.finally(() => {
      if (monitors.get(id) === tracked) monitors.delete(id)
    })
    monitors.set(id, tracked)
  }

  const initiate = async (signal?: AbortSignal): Promise<ChannelBindingSnapshot> => {
    const generation = operationGeneration
    const post = () => requestJson('bindings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }, signal)
    let value: unknown
    try {
      value = await post()
    } catch (error) {
      if (!isRecord(error) || error.code !== 'binding_generation_stale'
          || generation !== operationGeneration) throw error
      await requestJson('bindings')
      value = await post()
    }
    const snapshot = parseSnapshot(value)
    if (disposed || generation !== operationGeneration) throw safeError('binding_unavailable')
    reportSnapshot(snapshot)
    ensureMonitoring(snapshot)
    return cloneSnapshot(snapshot)
  }

  const queryStatus = async (): Promise<ChannelBindingStatus> => {
    return parseBindingStatus(await requestJson('bindings'))
  }

  const clearLocalBindingState = () => {
    operationGeneration += 1
    operationId = undefined
    current = undefined
    initiation = undefined
    initiationController?.abort()
    initiationController = undefined
    monitors.clear()
    for (const controller of operationControllers.values()) controller.abort()
    operationControllers.clear()
  }

  const unbind = async (): Promise<{ status: 'unbound' }> => {
    const value = await requestJson('bindings', { method: 'DELETE' })
    if (!isRecord(value) || value.status !== 'unbound') throw new Error('invalid unbind result')
    clearLocalBindingState()
    return { status: 'unbound' }
  }

  const startInitiation = (): Promise<ChannelBindingSnapshot> => {
    if (initiation !== undefined) return initiation
    initiationController = typeof AbortController === 'function' ? new AbortController() : undefined
    const pending = initiate(initiationController?.signal)
    const joined = pending.finally(() => {
      if (initiation === joined) {
        initiation = undefined
        initiationController = undefined
      }
    })
    initiation = joined
    return joined
  }

  const cancelOperation = (id: string): boolean => {
    if (disposed) return false
    if (initiation !== undefined && id === '') {
      operationGeneration += 1
      initiationController?.abort()
      initiation = undefined
      initiationController = undefined
      if (operationId !== undefined) {
        operationControllers.get(operationId)?.abort()
        operationControllers.delete(operationId)
        monitors.delete(operationId)
      }
      if (current !== undefined && current.state !== 'bound') {
        current = {
          ...cloneSnapshot(current),
          state: 'cancelled',
          revision: current.revision + 1,
          qr_url: null,
          verification: null,
          ...(current.error !== undefined ? { error: null } : {}),
        }
        try { options.onSnapshot?.(cloneSnapshot(current)) } catch { /* observer */ }
      } else if (current === undefined || current.state !== 'bound') {
        operationId = undefined
        current = undefined
      }
      return true
    }
    if (operationId !== id || current === undefined) return false
    if (current.state === 'cancelled') return true
    // A failed login stops monitoring, but its visible failure can be dismissed.
    if (current.state === 'bound') return false
    operationControllers.get(id)?.abort()
    operationControllers.delete(id)
    monitors.delete(id)
    operationGeneration += 1
    current = {
      ...cloneSnapshot(current),
      state: 'cancelled',
      revision: current.revision + 1,
      qr_url: null,
      verification: null,
      ...(current.error !== undefined ? { error: null } : {}),
    }
    try {
      options.onSnapshot?.(cloneSnapshot(current))
    } catch {
      // UI callbacks are observers; they cannot stop local cancellation.
    }
    return true
  }

  const workflow: ChannelBindingWorkflow = {
    async handleToolCall(call) {
      if (call.name !== CHANNEL_BINDING_TOOL_NAME) return undefined
      if (disposed) return { ok: false, error: safeError('binding_unavailable') }
      if (!toolArgumentsAreValid(call.arguments)) {
        return { ok: false, error: invalidArgumentsError(call.arguments) }
      }
      try {
        if (call.arguments.action === 'status') {
          return { ok: true, result: await queryStatus() }
        }
        if (call.arguments.action === 'unbind') {
          return { ok: true, result: await unbind() }
        }
        if (call.arguments.action === 'cancel') {
          if (initiation !== undefined && cancelOperation('')) {
            return { ok: true, result: { status: 'cancelled' } }
          }
          if (operationId === undefined || current === undefined
              || current.state === 'cancelled' || !cancelOperation(operationId)) {
            return { ok: true, result: { status: 'not_active' } }
          }
          return { ok: true, result: { status: 'cancelled' } }
        }
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

    cancel: cancelOperation,

    async verify(code) {
      if (disposed || typeof code !== 'string' || !code.trim()
          || operationId === undefined
          || current?.state !== 'verification') {
        return { accepted: false }
      }
      const id = operationId
      const generation = operationGeneration
      const signal = operationControllers.get(id)?.signal
      try {
        const value = await requestJson(
          `bindings/${encodeURIComponent(id)}/verify`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code: code.trim() }),
          },
          signal,
        )
        if (disposed || operationId !== id || operationGeneration !== generation) {
          return { accepted: false }
        }
        if (!isRecord(value) || typeof value.accepted !== 'boolean') {
          reportError(safeError('binding_unavailable'))
          return { accepted: false }
        }
        return { accepted: value.accepted }
      } catch (error) {
        if (disposed || operationId !== id || operationGeneration !== generation) {
          return { accepted: false }
        }
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
      monitors.clear()
      workflowAbortController?.abort()
      initiationController?.abort()
      initiationController = undefined
      for (const controller of operationControllers.values()) controller.abort()
      operationControllers.clear()
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
