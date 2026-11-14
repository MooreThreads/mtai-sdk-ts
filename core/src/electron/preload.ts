import type { AvatarMediaEvent } from '../voice/avatarMediaHost'
import type { AvatarBridge } from '../voice/avatarBridge'
import type { AttachmentKey, Layout } from '../voice/localMediaProtocol'
import type { TextureIdentity, TextureMessage } from './mainTexture'
import { TextureReceiver, type ImportedVideo } from './textureReceiver'
import { WebGLCover } from './webglCover'

/** SDK-owned channels, not an unrestricted page-to-native API. */
export const avatarChannels = Object.freeze({ prepare: 'mtai:avatar:prepare', retire: 'mtai:avatar:retire',
  prepared: 'mtai:avatar:prepared', disposed: 'mtai:avatar:disposed', accepted: 'mtai:avatar:accepted', retired: 'mtai:avatar:retired', submitted: 'mtai:avatar:submitted', failed: 'mtai:avatar:failed' })
export type PrepareAvatar = { target: AttachmentKey, layout: Layout }
export interface PreloadPorts {
  ipc: { on(channel: string, listener: (event: unknown, payload: any) => void): void,
    removeListener(channel: string, listener: (event: unknown, payload: any) => void): void,
    send(channel: string, payload: unknown): void }
  sharedTexture: { setSharedTextureReceiver(callback: (data: { importedSharedTexture: ImportedVideo }, message: TextureMessage) => Promise<void>): void }
}
function installWindowBridge() {
  const { ipcRenderer, contextBridge } = require('electron')
  let canvas: HTMLCanvasElement | undefined
  let receiver: { resize(width: number, height: number): void, dispose(): Promise<void> } | undefined
  let observer: ResizeObserver | undefined
  let avatarId: string | undefined, attachmentAvatar: string | undefined, generation: string | undefined
  const listeners = new Set<(event: AvatarMediaEvent) => void>()
  const ensureCanvas = () => {
    if (!canvas) {
      canvas = document.createElement('canvas')
      canvas.style.cssText = 'width:100%;height:100%;object-fit:contain;visibility:hidden;background:#1e1e1e'
    }
    return canvas
  }
  const bridge: AvatarBridge = {
    attach(target) {
      generation = target.generation; attachmentAvatar = target.avatarId
      if (!receiver) receiver = installAvatarBridge(ensureCanvas())
      return ipcRenderer.invoke('mtai:avatar:control', { operation: 'attach', target })
    },
    stop(request) { return ipcRenderer.invoke('mtai:avatar:control', { operation: 'stop', request }) },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async dispose() { observer?.disconnect(); observer = undefined; await receiver?.dispose(); receiver = undefined; canvas?.remove(); canvas = undefined },
    mount(selector, nextAvatar) {
      const parent = document.querySelector(selector)
      if (!parent) throw new Error('avatar presentation slot unavailable')
      // The receiver may initialize before the visible slot mounts. Remounting
      // moves the same canvas, retaining its independent same-avatar cover.
      const element = ensureCanvas()
      if (avatarId !== undefined && avatarId !== nextAvatar) element.style.visibility = 'hidden'
      avatarId = nextAvatar; parent.appendChild(element)
      observer?.disconnect()
      observer = new ResizeObserver(entries => {
        const size = entries[0]?.contentRect
        if (size && size.width > 0 && size.height > 0) receiver?.resize(Math.round(size.width), Math.round(size.height))
      })
      observer.observe(parent)
    },
    unmount() { observer?.disconnect(); observer = undefined; canvas?.remove() },
  }
  ipcRenderer.on('mtai:avatar:event', (_event: unknown, value: AvatarMediaEvent & { message?: string }) => {
    if (value.generation !== generation) return
    if (value.type === 'frameApplied' && canvas && (avatarId === undefined || avatarId === attachmentAvatar)) canvas.style.visibility = 'visible'
    const event: AvatarMediaEvent = value.type === 'failed' ? { ...value, error: new Error(value.message ?? 'avatar media failed') } : value
    for (const listener of [...listeners]) listener(event)
  })
  contextBridge.exposeInMainWorld('mtaiAvatar', bridge)
}

const same = (a: AttachmentKey, b: AttachmentKey) => a.sessionId === b.sessionId && a.generation === b.generation && a.attachment === b.attachment

/** Actual preload registration. The canvas is SDK-owned in the existing media
 * slot; it can be hidden/offDOM and never gates capture/conversation on show. */
export function installAvatarBridge(canvas: HTMLCanvasElement, input?: PreloadPorts): { resize(width: number, height: number): void, dispose(): Promise<void> }
export function installAvatarBridge(): void
export function installAvatarBridge(canvas?: HTMLCanvasElement, input?: PreloadPorts) {
  if (!canvas) { installWindowBridge(); return }
  const electron = input ? undefined : require('electron')
  const ports: PreloadPorts = input ?? { ipc: electron.ipcRenderer, sharedTexture: electron.sharedTexture }
  let graphicsFailure: Error | undefined
  const makeCover = () => new WebGLCover(canvas, error => { graphicsFailure = error; fail(error) })
  let cover = makeCover()
  let receiver: TextureReceiver | undefined, prepared: PrepareAvatar | undefined, disposed = false
  const fail = (error: Error) => { if (prepared && !disposed) ports.ipc.send(avatarChannels.failed, { target: prepared.target, message: error.message }) }
  const prepare = (_event: unknown, value: PrepareAvatar) => {
    if (disposed) return
    if (receiver) { fail(new Error('avatar receiver replacement requires joined retirement')); return }
    prepared = value
    try {
      if (graphicsFailure) { cover.dispose(); cover = makeCover(); graphicsFailure = undefined }
      cover.checkReady(); cover.resize(value.layout.width, value.layout.height)
    }
    catch (error) { graphicsFailure = error instanceof Error ? error : new Error(String(error)); fail(graphicsFailure); return }
    receiver = new TextureReceiver(value.target, value.layout.allocation, value.layout.width, value.layout.height, cover, {
      submitted: identity => ports.ipc.send(avatarChannels.submitted, { identity, ok: true }), failed: fail,
    })
    ports.ipc.send(avatarChannels.prepared, { target: value.target })
  }
  const retire = (_event: unknown, target: AttachmentKey) => {
    if (!prepared || !same(target, prepared.target)) { ports.ipc.send(avatarChannels.retired, { target }); return }
    const owned = receiver; receiver = undefined
    void (owned?.close() ?? Promise.resolve()).then(() => ports.ipc.send(avatarChannels.retired, { target })).catch(fail)
  }
  ports.ipc.on(avatarChannels.prepare, prepare); ports.ipc.on(avatarChannels.retire, retire)
  ports.sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }, message) => {
    if (!prepared || disposed || !same(message.identity, prepared.target)) { importedSharedTexture.release(); return }
    if (message.identity.sequence === 0n) {
      // Actual allocation import acceptance, not FRAME1 or a healthy playback
      // observation. Do not copy unproduced pixels or advance receiver sequence.
      let frame: VideoFrame | undefined
      try {
        if (graphicsFailure) throw graphicsFailure
        cover.checkReady()
        frame = importedSharedTexture.getVideoFrame()
        if (frame.displayWidth !== prepared.layout.width || frame.displayHeight !== prepared.layout.height) throw new Error('avatar allocation dimensions mismatch')
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); throw error }
      finally { frame?.close(); importedSharedTexture.release() }
      ports.ipc.send(avatarChannels.accepted, { target: prepared.target })
      return
    }
    if (!receiver) { importedSharedTexture.release(); return }
    receiver.receive(importedSharedTexture, message)
  })
  return {
    resize(width: number, height: number) {
      if (!prepared) return
      const scale = Math.min(width / prepared.layout.width, height / prepared.layout.height)
      cover.resize(Math.round(prepared.layout.width * scale), Math.round(prepared.layout.height * scale))
    },
    async dispose() { if (disposed) return
      ports.ipc.send(avatarChannels.disposed, { target: prepared?.target })
      disposed = true
      ports.ipc.removeListener(avatarChannels.prepare, prepare); ports.ipc.removeListener(avatarChannels.retire, retire)
      await receiver?.close(); receiver = undefined; cover.dispose()
    },
  }
}
