/** @jest-environment jsdom */
import { createChannelBindingUI } from './channelBindingUI'
import { ChannelBindingSnapshot, ChannelBindingWorkflow } from './channelBinding'
import type { Logger } from '../types'

const snapshot = (extra: Partial<ChannelBindingSnapshot> = {}): ChannelBindingSnapshot => ({
  operation_id: 'one', state: 'qr', revision: 1, qr_url: 'https://wechat.example/login?token=secret', verification: null, ...extra,
})
let host: HTMLElement
let workflow: ChannelBindingWorkflow
beforeEach(() => {
  jest.useFakeTimers()
  host = document.createElement('div')
  document.body.append(host)
  workflow = { verify: jest.fn(async () => ({ accepted: true })), cancel: jest.fn(() => true), dispose: jest.fn(), handleToolCall: jest.fn(), snapshot: undefined }
})
afterEach(() => { jest.useRealTimers(); document.body.replaceChildren() })

function captureLogger() {
  const log = jest.fn()
  const warn = jest.fn()
  const logger = {
    debug: jest.fn(),
    log,
    warn,
    error: jest.fn(),
    push: jest.fn(),
  } as unknown as Logger
  const messages = () => [
    ...log.mock.calls.map(([message]) => message as string),
    ...warn.mock.calls.map(([message]) => message as string),
  ]
  return { logger, log, warn, messages, output: () => messages().join('\n') }
}

function throwingLogger() {
  const boom = () => { throw new Error('logger down') }
  return {
    debug: boom, log: boom, warn: boom, error: boom, push: boom,
  } as unknown as Logger
}

test('renders local square SVG with quiet zone; fades in, retains scanned QR, then fades out before removal', () => {
  const ui = createChannelBindingUI(host, workflow)
  ui.update(snapshot())
  const qr = host.querySelector('[data-binding-qr]') as HTMLElement
  expect(qr.style.opacity).toBe('0')
  expect(qr.querySelector('img')).toBeNull()
  const svg = qr.querySelector('svg')!
  expect(svg.getAttribute('shape-rendering')).toBe('crispEdges')
  expect(svg.querySelector('path')!.getAttribute('d')).toMatch(/M4,4/)
  jest.advanceTimersByTime(20)
  expect(qr.style.opacity).toBe('1')
  ui.update(snapshot({ state: 'scanned', revision: 2, qr_url: null }))
  expect(qr.querySelector('svg')).toBe(svg)
  ui.update(snapshot({ state: 'bound', revision: 3, qr_url: null }))
  expect(qr.style.opacity).toBe('0')
  expect(qr.querySelector('svg')).toBe(svg)
  jest.advanceTimersByTime(200)
  expect(qr.querySelector('svg')).toBeNull()
  expect(host.textContent).toContain('微信绑定成功')
  jest.advanceTimersByTime(3000)
  expect((host.firstElementChild as HTMLElement).hidden).toBe(true)
  ui.dispose()
})

test('replacement fences fading removals and keeps a stable square slot', () => {
  const ui = createChannelBindingUI(host, workflow)
  ui.update(snapshot())
  jest.advanceTimersByTime(20)
  const qr = host.querySelector('[data-binding-qr]') as HTMLElement
  const first = qr.innerHTML
  ui.update(snapshot({ qr_url: 'replacement', revision: 2 }))
  expect(qr.style.opacity).toBe('0')
  expect(qr.innerHTML).toBe(first)
  ui.update(snapshot({ operation_id: 'two', qr_url: 'new operation' }))
  jest.runOnlyPendingTimers()
  jest.advanceTimersByTime(20)
  expect(qr.querySelector('svg')).not.toBeNull()
  expect(qr.innerHTML).not.toBe(first)
  expect(qr.style.aspectRatio).toBe('1')
  ui.dispose()
  jest.runOnlyPendingTimers()
  expect(host.children).toHaveLength(0)
})

test.each(['revision', 'operation', 'dispose'])('verification stays local and ignores stale %s completion', async replacement => {
  let resolve!: (value: { accepted: boolean }) => void
  workflow.verify = jest.fn(() => new Promise(r => { resolve = r }))
  const ui = createChannelBindingUI(host, workflow)
  const challenge = snapshot({ state: 'verification', verification: { required: true, retry: false } })
  ui.update(challenge)
  const input = host.querySelector('input')!
  input.value = '123456'
  const form = host.querySelector('form')!
  form.dispatchEvent(new Event('submit', { cancelable: true }))
  expect(workflow.verify).toHaveBeenCalledWith('123456')
  expect(input.value).toBe('')
  if (replacement === 'dispose') ui.dispose()
  else ui.update({ ...challenge, revision: 2, operation_id: replacement === 'operation' ? 'two' : 'one' })
  resolve({ accepted: true })
  await Promise.resolve()
  expect(host.textContent).not.toContain('验证码已提交')
  ui.dispose()
})

test('cancelled transitions cannot hide a replacement and disposal removes pending DOM listeners', () => {
  const ui = createChannelBindingUI(host, workflow)
  ui.update(snapshot())
  jest.advanceTimersByTime(20)
  ui.update(snapshot({ state: 'cancelled', qr_url: null, revision: 2 }))
  ui.update(snapshot({ operation_id: 'two', qr_url: 'replacement' }))
  jest.advanceTimersByTime(200)
  expect((host.firstElementChild as HTMLElement).hidden).toBe(false)
  expect(host.querySelector('svg')).not.toBeNull()
  const dismiss = host.querySelector('[data-binding-dismiss]') as HTMLButtonElement
  ui.dispose()
  dismiss.click()
  ui.update(snapshot())
  ui.error({ code: 'binding_unavailable', message: 'late error' })
  jest.runOnlyPendingTimers()
  expect(workflow.cancel).not.toHaveBeenCalled()
  expect(host.children).toHaveLength(0)
})

test('a QR encoding failure is visible and never fetches or injects the payload', () => {
  const ui = createChannelBindingUI(host, workflow)
  ui.update(snapshot({ qr_url: 'x'.repeat(4000) }))
  expect(host.textContent).toContain('二维码无法显示')
  expect(host.querySelector('img, svg, script')).toBeNull()
  ui.dispose()
})

test('verification success/rejection, errors and dismissal are owned by the SDK', async () => {
  const ui = createChannelBindingUI(host, workflow)
  ui.update(snapshot({ state: 'verification', verification: { required: true, retry: true } }))
  const input = host.querySelector('input')!
  const form = host.querySelector('form')!
  input.value = ' 123 '
  form.dispatchEvent(new Event('submit', { cancelable: true }))
  await Promise.resolve()
  expect(host.textContent).toContain('验证码已提交')
  workflow.verify = jest.fn(async () => ({ accepted: false }))
  input.value = '456'
  form.dispatchEvent(new Event('submit', { cancelable: true }))
  await Promise.resolve()
  expect(host.textContent).toContain('验证码未通过')
  ui.error({ code: 'binding_unavailable', message: 'WeChat binding service unavailable' })
  expect(host.textContent).toContain('WeChat binding service unavailable')
  ;(host.querySelector('[data-binding-dismiss]') as HTMLButtonElement).click()
  expect(workflow.cancel).toHaveBeenCalledWith('one')
  expect(workflow.dispose).not.toHaveBeenCalled()
  jest.advanceTimersByTime(200)
  expect((host.firstElementChild as HTMLElement).hidden).toBe(true)
  ui.dispose()
})

test('emits content-free UI lifecycle logs without qr or operation secrets', () => {
  const capture = captureLogger()
  const ui = createChannelBindingUI(host, workflow, capture.logger)
  ui.update(snapshot())
  jest.advanceTimersByTime(20)
  ui.update(snapshot({ state: 'scanned', revision: 2, qr_url: null }))
  ui.update(snapshot({ state: 'bound', revision: 3, qr_url: null }))
  jest.advanceTimersByTime(200)
  jest.advanceTimersByTime(3000)
  ;(host.querySelector('[data-binding-dismiss]') as HTMLButtonElement).click()
  jest.advanceTimersByTime(200)
  ui.error({ code: 'leaky_secret_code', message: 'raw backend detail token=top-secret' })
  ui.dispose()

  expect(capture.log.mock.calls.map(([message]) => message)).toEqual([
    'channel_binding_ui update state=qr revision=1 has_qr=true same_op=false',
    'channel_binding_ui qr_rendered',
    'channel_binding_ui update state=scanned revision=2 has_qr=false same_op=true',
    'channel_binding_ui update state=bound revision=3 has_qr=false same_op=true',
    'channel_binding_ui hide reason=bound',
    'channel_binding_ui dismiss state=bound revision=3',
    'channel_binding_ui hide reason=dismiss',
    'channel_binding_ui dispose state=bound revision=3',
  ])
  expect(capture.warn.mock.calls.map(([message]) => message)).toEqual([
    'channel_binding_ui error code=unknown',
  ])
  for (const secret of ['wechat.example', 'token=secret', 'top-secret', 'raw backend', 'leaky_secret_code', 'one']) {
    expect(capture.output()).not.toContain(secret)
  }
})

test('cancelled snapshots hide with a cancelled reason', () => {
  const capture = captureLogger()
  const ui = createChannelBindingUI(host, workflow, capture.logger)
  ui.update(snapshot())
  ui.update(snapshot({ state: 'cancelled', revision: 2, qr_url: null }))
  expect(capture.log).toHaveBeenCalledWith('channel_binding_ui hide reason=cancelled')
  ui.dispose()
})

test('logs a sanitized qr render failure without the payload', () => {
  const capture = captureLogger()
  const ui = createChannelBindingUI(host, workflow, capture.logger)
  ui.update(snapshot({ qr_url: 'x'.repeat(4000) }))
  expect(capture.warn.mock.calls.map(([message]) => message)).toEqual([
    'channel_binding_ui qr_render_failed',
  ])
  expect(capture.log.mock.calls.map(([message]) => message)).toEqual([
    'channel_binding_ui update state=qr revision=1 has_qr=true same_op=false',
  ])
  expect(capture.output()).not.toContain('xxxx')
  expect(host.textContent).toContain('二维码无法显示')
  ui.dispose()
})

test('a throwing logger never disturbs UI rendering, dismissal, or disposal', () => {
  const ui = createChannelBindingUI(host, workflow, throwingLogger())
  ui.update(snapshot())
  jest.advanceTimersByTime(20)
  const qr = host.querySelector('[data-binding-qr]') as HTMLElement
  expect(qr.querySelector('svg')).not.toBeNull()
  expect(qr.style.opacity).toBe('1')
  ui.update(snapshot({ state: 'cancelled', revision: 2, qr_url: null }))
  jest.advanceTimersByTime(200)
  expect((host.firstElementChild as HTMLElement).hidden).toBe(true)
  ui.update(snapshot({ operation_id: 'two', revision: 1 }))
  expect(host.textContent).toContain('请使用微信扫描二维码')
  ;(host.querySelector('[data-binding-dismiss]') as HTMLButtonElement).click()
  expect(workflow.cancel).toHaveBeenCalledWith('two')
  ui.error({ code: 'binding_unavailable', message: 'WeChat binding service unavailable' })
  expect(host.textContent).toContain('WeChat binding service unavailable')
  ui.dispose()
  jest.runOnlyPendingTimers()
  expect(host.children).toHaveLength(0)
})
