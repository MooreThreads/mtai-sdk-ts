import type { AvatarMediaEvent, AvatarMediaHost } from './avatarMediaHost'

/** Narrow SDK bridge; no socket paths, descriptors, pixels or native calls. */
export interface AvatarBridge extends AvatarMediaHost {
  mount(selector: string, avatarId: string): void
  unmount(): void
}

export function avatarBridge(): AvatarBridge {
  const bridge = (globalThis as typeof globalThis & { mtaiAvatar?: AvatarBridge }).mtaiAvatar
  if (!bridge) throw new Error('SDK avatar preload bridge unavailable')
  return bridge
}

/** Each conversation owns its subscription, not the window-wide native host. */
export function createAvatarMediaHost(bridge: AvatarBridge = avatarBridge()): AvatarMediaHost {
  let generation: string | undefined
  const subscriptions = new Set<() => void>()
  return {
    attach(target) { generation = target.generation; return bridge.attach(target) },
    stop(request) { return bridge.stop(request) },
    subscribe(listener: (event: AvatarMediaEvent) => void) {
      const off = bridge.subscribe(listener); subscriptions.add(off)
      return () => { subscriptions.delete(off); off() }
    },
    async dispose() {
      for (const off of subscriptions) off()
      subscriptions.clear()
      const owned = generation; generation = undefined
      if (owned) await bridge.stop({ generation: owned, reason: 'detach' })
    },
  }
}
