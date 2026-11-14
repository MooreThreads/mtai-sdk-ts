import type { AvatarAttachment, AvatarMediaEvent, AvatarMediaHost } from '../voice/avatarMediaHost'
import type { AttachmentKey, Layout } from '../voice/localMediaProtocol'
import { AttachmentRuntime, type AvatarNative } from './attachmentRuntime'
import type { SharedTextures, TextureIdentity } from './mainTexture'
import { avatarChannels } from './preload'

type MainEvent = { sender: unknown, senderFrame: unknown }
export interface AvatarWindow {
  webContents: { readonly mainFrame: unknown, send(channel: string, payload: unknown): void,
    on(name: string, listener: (...args: any[]) => void): void, removeListener(name: string, listener: (...args: any[]) => void): void }
  on(name: string, listener: (...args: any[]) => void): void
  removeListener(name: string, listener: (...args: any[]) => void): void
}
export interface MainPorts {
  ipcMain: { on(channel: string, listener: (event: MainEvent, payload: any) => void): void,
    removeListener(channel: string, listener: (event: MainEvent, payload: any) => void): void }
  app?: { on(name: string, listener: (...args: any[]) => void): void, removeListener(name: string, listener: (...args: any[]) => void): void }
  sharedTexture: SharedTextures
}
const same = (a?: AttachmentKey, b?: AttachmentKey) => !!a && !!b && a.sessionId === b.sessionId && a.generation === b.generation && a.attachment === b.attachment
function wait() { let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }

/** One host for the existing main window. Renderer messages never choose the
 * socket path, native addon, FD, or arbitrary native operations. */
export function installAvatarHost(window: AvatarWindow, options: { socketPath: string, nativeAddonPath: string },
  ports: MainPorts = require('electron'), native: AvatarNative = require(options.nativeAddonPath)) : AvatarMediaHost {
  const listeners = new Set<(event: AvatarMediaEvent) => void>()
  let runtime: AttachmentRuntime | undefined, disposed = false, pendingTarget: AttachmentKey | undefined
  let prepared: ReturnType<typeof wait> | undefined, accepted: ReturnType<typeof wait> | undefined, retired: ReturnType<typeof wait> | undefined
  let unavailable = false, documentFailed = false
  let retirement: Promise<void> | undefined
  let revision = 0, requestedGeneration: string | undefined
  const emit = (event: AvatarMediaEvent) => { for (const listener of [...listeners]) listener(event) }
  const trusted = (event: MainEvent) => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
  const onPrepared = (event: MainEvent, value: { target: AttachmentKey }) => { if (trusted(event) && same(value?.target, pendingTarget)) prepared?.resolve() }
  const onAccepted = (event: MainEvent, value: { target: AttachmentKey }) => { if (trusted(event) && same(value?.target, pendingTarget)) accepted?.resolve() }
  const onRetired = (event: MainEvent, value: { target: AttachmentKey }) => { if (trusted(event) && same(value?.target, pendingTarget)) retired?.resolve() }
  const onSubmitted = (event: MainEvent, value: { identity: TextureIdentity, ok: boolean }) => {
    if (trusted(event) && same(value?.identity, pendingTarget)) runtime?.submitted(value.identity, value.ok)
  }
  const onDisposed = (event: MainEvent) => { if (trusted(event)) gone() }
  const onFailed = (event: MainEvent, value: { target: AttachmentKey, message: string }) => {
    if (trusted(event) && same(value?.target, pendingTarget)) fail(new Error(value.message))
  }
  const fail = (error: Error) => {
    prepared?.reject(error); accepted?.reject(error); retired?.reject(error)
    try { if (runtime) emit({ type: 'failed', generation: runtime.attachment.generation, error }) }
    finally { void closeCurrent().catch(() => {}) }
  }
  const closeCurrent = () => {
    if (retirement) return retirement
    const owned = runtime
    if (!owned) return Promise.resolve()
    const attempt = owned.close(); retirement = attempt
    void attempt.then(() => { if (runtime === owned) runtime = undefined; retirement = undefined }, () => { retirement = undefined })
    return attempt
  }
  const gone = () => { documentFailed = true; unavailable = true; retired?.resolve(); fail(new Error('avatar renderer retired')) }
  const navigating = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
    if (mainFrame && !inPlace) {
      gone()
      // A new document may install a fresh bridge. Keep it unavailable while
      // loading; any preload failure for this document must survive load end.
      documentFailed = false
    }
  }
  const loaded = () => { unavailable = documentFailed }
  const gpuGone = (_event: unknown, details: { type: string }) => { if (details.type === 'GPU') gone() }
  const destroyed = () => { gone(); void dispose().catch(() => {}) }
  const handlers = [[avatarChannels.prepared, onPrepared], [avatarChannels.accepted, onAccepted], [avatarChannels.retired, onRetired],
    [avatarChannels.disposed, onDisposed], [avatarChannels.submitted, onSubmitted], [avatarChannels.failed, onFailed]] as const
  for (const [channel, handler] of handlers) ports.ipcMain.on(channel, handler)
  window.webContents.on('did-start-navigation', navigating); window.webContents.on('did-finish-load', loaded)
  window.webContents.on('render-process-gone', gone); window.webContents.on('preload-error', gone)
  window.on('closed', destroyed); ports.app?.on('child-process-gone', gpuGone)
  async function dispose() {
    disposed = true; ++revision
    await closeCurrent()
    for (const [channel, handler] of handlers) ports.ipcMain.removeListener(channel, handler)
    window.webContents.removeListener('did-start-navigation', navigating); window.webContents.removeListener('did-finish-load', loaded)
    window.webContents.removeListener('render-process-gone', gone); window.webContents.removeListener('preload-error', gone)
    window.removeListener('closed', destroyed); ports.app?.removeListener('child-process-gone', gpuGone); listeners.clear()
  }
  return {
    async attach(attachment: AvatarAttachment) {
      if (disposed) throw new Error('avatar host disposed')
      const operation = ++revision
      requestedGeneration = attachment.generation
      await closeCurrent()
      if (disposed || operation !== revision) throw new Error('avatar attachment superseded')
      prepared = accepted = retired = undefined
      pendingTarget = { sessionId: attachment.dh2dSessionId, generation: attachment.generation, attachment: attachment.attachment }
      const destination = {
        get frame() { return window.webContents.mainFrame },
        prepare(target: AttachmentKey, layout: Layout) {
          if (unavailable) return Promise.reject(new Error('avatar renderer unavailable'))
          prepared = wait(); window.webContents.send(avatarChannels.prepare, { target, layout }); return prepared.promise
        },
        accepted(_target: AttachmentKey) { accepted = wait(); return accepted.promise },
        retire(target: AttachmentKey) {
          prepared?.reject(new Error('avatar preparation retired')); accepted?.reject(new Error('avatar preparation retired'))
          if (unavailable || !prepared) return Promise.resolve()
          retired = wait(); window.webContents.send(avatarChannels.retire, target); return retired.promise
        },
      }
      runtime = new AttachmentRuntime(attachment, options.socketPath, native, ports.sharedTexture, destination, emit)
      return runtime.attach()
    },
    async stop(request) {
      if (request.reason === 'detach' && request.generation === requestedGeneration) { ++revision; await closeCurrent(); return }
      if (!runtime || request.generation !== runtime.attachment.generation) return
      await runtime.stop(request.turnId)
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    dispose,
  }
}
