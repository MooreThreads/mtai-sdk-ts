import { TURN_STRIPE_HEIGHT } from './turnStripe'

/** Presentation only: canvas sampling still reads the original video frame. */
export function createPlayerPresentation(
  container: HTMLElement, video: HTMLVideoElement, cover: HTMLCanvasElement, showTurnId: boolean,
): { showError(message?: string): void, dispose(): void } {
  const layer = document.createElement('div')
  layer.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:100%;height:100%;overflow:hidden'
  container.appendChild(layer)
  layer.append(video, cover)
  let disposed = false
  let errorPanel: HTMLDivElement | undefined
  let aspectRatio: number | undefined
  const ownsMedia = () => video.parentElement === layer && cover.parentElement === layer
  const showError = (message?: string) => {
    if (disposed || !ownsMedia()) return
    errorPanel?.remove()
    errorPanel = undefined
    if (!message) return
    errorPanel = document.createElement('div')
    errorPanel.setAttribute('role', 'alert')
    errorPanel.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);'
      + 'z-index:1;box-sizing:border-box;width:max-content;max-width:calc(100% - 32px);padding:16px 24px;'
      + 'border:1px solid rgba(255,255,255,.25);border-radius:8px;background:rgba(17,24,39,.95);color:#f8fafc;'
      + 'box-shadow:0 4px 24px rgba(0,0,0,.4);font:14px/1.5 system-ui,sans-serif;text-align:center;'
      + 'white-space:pre-wrap;overflow-wrap:anywhere'
    errorPanel.textContent = message
    // The panel is in fitted video coordinates, but never stripe-scaled.
    layer.append(errorPanel)
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
    errorPanel = undefined
  }
  return { showError, dispose }
}
