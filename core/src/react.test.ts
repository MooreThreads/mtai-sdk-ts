/** @jest-environment jsdom */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { Avatar } from './react'
import type { DH2DSession } from './dh2d/types'
import type { AvatarStatus } from './voice/avatarMediaHost'
function render(element: ReturnType<typeof createElement>) {
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(element))
  return { unmount() { act(() => root.unmount()); container.remove() } }
}
afterEach(() => { document.body.innerHTML = '' })
test('Avatar mounts presentation only, replays status and remounts without disposing conversation or audio', () => {
  const handlers = new Set<(status: AvatarStatus) => void>()
  const mountAvatar = jest.fn(), unmountAvatar = jest.fn(), close = jest.fn(), detachMedia = jest.fn(), send = jest.fn()
  const session = { mountAvatar, unmountAvatar, close, detachMedia, send,
    on: (_event: string, listener: (status: AvatarStatus) => void) => { handlers.add(listener); listener('loading'); return () => { handlers.delete(listener) } } } as unknown as DH2DSession
  const status = jest.fn()
  const first = render(createElement(Avatar, { session, onStatusChange: status }))
  expect(document.querySelector(mountAvatar.mock.calls[0][0])).not.toBeNull();expect(status).toHaveBeenCalledWith('loading')
  act(() => { for (const handler of handlers) handler('failed') });expect(document.querySelector('[role="alert"]')?.textContent).toBe('Avatar media unavailable')
  act(() => { for (const handler of handlers) handler('ready') });expect(document.querySelector('[role="alert"]')).toBeNull();expect(status).toHaveBeenLastCalledWith('ready')
  act(() => { for (const handler of handlers) handler('failed') });expect(document.querySelector('[role="alert"]')).not.toBeNull()
  first.unmount();expect(unmountAvatar).toHaveBeenCalledTimes(1)
  const second = render(createElement(Avatar, { session, onStatusChange: status }));expect(mountAvatar).toHaveBeenCalledTimes(2)
  expect(close).not.toHaveBeenCalled();expect(detachMedia).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();second.unmount()
})
