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
const same = (a: AttachmentKey, b: AttachmentKey) => a.sessionId === b.sessionId && a.generation === b.generation && a.attachment === b.attachment

/** Actual preload registration. The canvas is SDK-owned in the existing media
 * slot; it can be hidden/offDOM and never gates capture/conversation on show. */
export function installAvatarBridge(canvas: HTMLCanvasElement, input?: PreloadPorts) {
  const electron = input ? undefined : require('electron')
  const ports: PreloadPorts = input ?? { ipc: electron.ipcRenderer, sharedTexture: electron.sharedTexture }
  let graphicsFailure: Error | undefined
  const cover = new WebGLCover(canvas, error => { graphicsFailure = error; fail(error) })
  let receiver: TextureReceiver | undefined, prepared: PrepareAvatar | undefined, disposed = false
  const fail = (error: Error) => { if (prepared && !disposed) ports.ipc.send(avatarChannels.failed, { target: prepared.target, message: error.message }) }
  const prepare = (_event: unknown, value: PrepareAvatar) => {
    if (disposed) return
    if (receiver) { fail(new Error('avatar receiver replacement requires joined retirement')); return }
    prepared = value
    try { if (graphicsFailure) throw graphicsFailure; cover.checkReady() }
    catch (error) { fail(error instanceof Error ? error : new Error(String(error))); return }
    receiver = new TextureReceiver(value.target, value.layout.allocation, value.layout.width, value.layout.height, cover, {
      submitted: identity => ports.ipc.send(avatarChannels.submitted, { identity, ok: true }), failed: fail,
    })
    ports.ipc.send(avatarChannels.prepared, { target: value.target })
  }
  const retire = (_event: unknown, target: AttachmentKey) => {
    if (!prepared || !same(target, prepared.target)) { ports.ipc.send(avatarChannels.retired, { target }); return }
    const owned = receiver; receiver = undefined
    void (owned?.close() ?? Promise.resolve()).then(() => ports.ipc.send(avatarChannels.retired, { target }), fail)
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
    resize(width: number, height: number) { cover.resize(width, height) },
    async dispose() { if (disposed) return
      ports.ipc.send(avatarChannels.disposed, { target: prepared?.target })
      disposed = true
      ports.ipc.removeListener(avatarChannels.prepare, prepare); ports.ipc.removeListener(avatarChannels.retire, retire)
      await receiver?.close(); receiver = undefined; cover.dispose()
    },
  }
}
