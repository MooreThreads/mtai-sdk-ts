import { TURN_STRIPE_HEIGHT } from './turnStripe'
import { createPlayerErrorBadge } from './serviceUnavailableBadge'

/** Presentation only: canvas sampling still reads the original video frame. */
export function createPlayerPresentation(
  container: HTMLElement, video: HTMLVideoElement, cover: HTMLCanvasElement, showTurnId: boolean,
) {
  const layer = document.createElement('div')
  layer.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:100%;height:100%;overflow:hidden'
  container.appendChild(layer)
  layer.append(video, cover)
  // A replacement player can take ownership before the old controller is disposed.
  container.querySelector(':scope > [data-mtai-player-error]')?.remove()
  let disposed = false
  let badge: HTMLDivElement | undefined
  let terminalError: string | undefined
  let voiceNotice: string | undefined
  let renderedMessage: string | undefined
  let renderedTerminal = false
  let aspectRatio: number | undefined
  const ownsMedia = () => video.parentElement === layer && cover.parentElement === layer
  const refreshBadge = () => {
    if (disposed || !ownsMedia()) return
    const message = terminalError || voiceNotice
    const terminal = Boolean(terminalError)
    if (message === renderedMessage && terminal === renderedTerminal) return
    renderedMessage = message
    renderedTerminal = terminal
    badge?.remove()
    badge = message ? createPlayerErrorBadge(container.ownerDocument, message, terminal) : undefined
    if (badge) container.append(badge)
  }
  const showError = (message?: string) => {
    terminalError = message
    refreshBadge()
  }
  const showVoiceNotice = (message?: string) => {
    voiceNotice = message
    refreshBadge()
  }
  const update = () => {
    if (disposed || !ownsMedia()) return
    const width = video.videoWidth
    const height = video.videoHeight
    // Source retirement clears natural dimensions, not the visible error UI.
    if (width && height) aspectRatio = width / height
    if (aspectRatio && container.clientWidth && container.clientHeight) {
      const fittedWidth = Math.min(container.clientWidth, container.clientHeight * aspectRatio)
      layer.style.width = `${fittedWidth}px`
      layer.style.height = `${fittedWidth / aspectRatio}px`
    }
    const transform = !showTurnId && height > TURN_STRIPE_HEIGHT
      ? `scale(${height / (height - TURN_STRIPE_HEIGHT)})` : 'none'
    for (const element of [video, cover]) {
      element.style.transformOrigin = 'center bottom'
      element.style.transform = transform
    }
  }
  video.addEventListener('loadedmetadata', update)
  video.addEventListener('resize', update)
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : undefined
  observer?.observe(container)
  window.addEventListener('resize', update)
  update()
  const dispose = () => {
    if (disposed) return
    disposed = true
    observer?.disconnect()
    window.removeEventListener('resize', update)
    video.removeEventListener('loadedmetadata', update)
    video.removeEventListener('resize', update)
    // A newer player may already have adopted these shared media nodes.
    for (const element of [video, cover]) {
      if (element.parentElement === layer) container.append(element)
    }
    layer.remove()
    badge?.remove()
    badge = undefined
  }
  return { showError, showVoiceNotice, dispose }
}
