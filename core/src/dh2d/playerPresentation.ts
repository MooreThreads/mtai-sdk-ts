import { TURN_STRIPE_HEIGHT } from './turnStripe'

/** Presentation only: canvas sampling still reads the original video frame. */
export function createPlayerPresentation(
  container: HTMLElement, video: HTMLVideoElement, cover: HTMLCanvasElement, showTurnId: boolean,
): () => void {
  const layer = document.createElement('div')
  layer.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:100%;height:100%;overflow:hidden'
  container.appendChild(layer)
  layer.append(video, cover)
  let disposed = false
  const ownsMedia = () => video.parentElement === layer && cover.parentElement === layer
  const update = () => {
    if (disposed || !ownsMedia()) return
    const width = video.videoWidth
    const height = video.videoHeight
    if (width && height && container.clientWidth && container.clientHeight) {
      const fit = Math.min(container.clientWidth / width, container.clientHeight / height)
      layer.style.width = `${width * fit}px`
      layer.style.height = `${height * fit}px`
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
  return () => {
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
  }
}
