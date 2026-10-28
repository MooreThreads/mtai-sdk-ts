/** @jest-environment jsdom */
import { dh2dHooks } from './hooks'
import { setConfig } from '../config'

let resize: () => void
let disconnect: jest.Mock
beforeEach(() => {
  setConfig({ endpoint: 'http://localhost' })
  disconnect = jest.fn()
  ;(globalThis as any).ResizeObserver = class {
    constructor(callback: () => void) { resize = callback }
    observe() {}
    disconnect = disconnect
  }
})
afterEach(() => { document.body.replaceChildren(); delete (globalThis as any).ResizeObserver })

function player(width = 640, height = 360) {
  const parent = document.createElement('div')
  document.body.append(parent)
  const elements = dh2dHooks.getOrCreatePlayer(parent)
  const container = parent.querySelector('#mt_dh2d_container') as HTMLElement
  Object.defineProperties(container, { clientWidth: { value: width, configurable: true }, clientHeight: { value: height } })
  Object.defineProperties(elements.video, { videoWidth: { value: 640 }, videoHeight: { value: 360 } })
  elements.video.dispatchEvent(new Event('loadedmetadata'))
  return { ...elements, container }
}

test('default hides precisely the stripe with uniform bottom-centered scaling of video and cover', () => {
  const p = player()
  const layer = p.video.parentElement!
  expect(layer.style.overflow).toBe('hidden')
  expect(layer.style.width).toBe('640px')
  expect(layer.style.height).toBe('360px')
  expect(p.video.style.transform).toBe(`scale(${360 / 352})`)
  expect(p.video.style.transformOrigin).toBe('center bottom')
  expect(p.cover!.style.transform).toBe(p.video.style.transform)
  Object.defineProperty(p.container, 'clientWidth', { value: 320 })
  resize()
  expect(layer.style.width).toBe('320px')
  expect(layer.style.height).toBe('180px')
  expect(layer.style.left).toBe('50%')
  p.dispose!()
  expect(disconnect).toHaveBeenCalledTimes(1)
})

test('an overlapping player keeps ownership when the older controller updates or disposes', () => {
  const old = player()
  const oldLayer = old.video.parentElement!
  const oldResize = resize
  setConfig({ endpoint: 'http://localhost', show_turn_id: true })
  const next = dh2dHooks.getOrCreatePlayer(old.container.parentElement!)
  const nextLayer = next.video.parentElement!
  expect(next.video).toBe(old.video)
  expect(nextLayer).not.toBe(oldLayer)
  old.dispose!()
  expect(next.video.parentElement).toBe(nextLayer)
  expect(next.cover!.parentElement).toBe(nextLayer)
  expect(oldLayer.isConnected).toBe(false)
  oldResize()
  expect(next.video.style.transform).toBe('none')
  old.dispose!()
  expect(next.video.parentElement).toBe(nextLayer)
  next.dispose!()
})

test('a superseded controller cannot change the new owner before disposal', () => {
  const old = player()
  const oldResize = resize
  setConfig({ endpoint: 'http://localhost', show_turn_id: true })
  const next = dh2dHooks.getOrCreatePlayer(old.container.parentElement!)
  oldResize()
  expect(next.video.style.transform).toBe('none')
  expect(next.cover!.style.transform).toBe('none')
  next.dispose!()
  oldResize()
  expect(next.video.style.transform).toBe('none')
  old.dispose!()
})

test('global true preserves full frame and a later omission restores the default for a new player', () => {
  setConfig({ endpoint: 'http://localhost', show_turn_id: true })
  const full = player()
  expect(full.video.style.transform).toBe('none')
  full.dispose!()
  setConfig({ endpoint: 'http://localhost' })
  const hidden = player()
  expect(hidden.video.style.transform).toBe(`scale(${360 / 352})`)
  hidden.dispose!()
})
