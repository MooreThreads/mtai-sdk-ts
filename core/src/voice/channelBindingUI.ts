import qrcode from 'qrcode-generator'
import type { ChannelBindingError, ChannelBindingSnapshot, ChannelBindingWorkflow } from './channelBinding'

const FADE_MS = 180
const messages: Record<ChannelBindingSnapshot['state'], string> = {
  initiating: '正在准备微信二维码…', qr: '请使用微信扫描二维码', scanned: '已扫描，请在微信中确认',
  expired: '二维码已更新，请重新扫描', verification: '请输入微信显示的验证码',
  bound: '微信绑定成功', failed: '微信绑定失败，请稍后重试', cancelled: '微信绑定已关闭',
}

/** Local encoding, with a four-module quiet zone included in the SVG viewBox. */
function qrSvg(text: string): SVGSVGElement {
  const qr = qrcode(0, 'M')
  const previousEncoding = qrcode.stringToBytes
  try {
    qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8']
    qr.addData(text)
  } finally {
    qrcode.stringToBytes = previousEncoding
  }
  qr.make()
  const size = qr.getModuleCount()
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', `0 0 ${size + 8} ${size + 8}`)
  svg.setAttribute('shape-rendering', 'crispEdges')
  svg.style.cssText = 'display:block;width:100%;height:100%;background:white'
  const path = document.createElementNS(ns, 'path')
  const cells: string[] = []
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (qr.isDark(row, col)) cells.push(`M${col + 4},${row + 4}h1v1h-1z`)
    }
  }
  path.setAttribute('d', cells.join(''))
  path.setAttribute('fill', '#000')
  svg.append(path)
  return svg
}

/** Internal, one controller per connection; never owns backend cancellation. */
export function createChannelBindingUI(container: HTMLElement, workflow: ChannelBindingWorkflow) {
  const root = document.createElement('section')
  root.dataset.bindingUi = ''
  root.setAttribute('aria-live', 'polite')
  root.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:20;width:min(220px,72%);max-height:calc(100% - 24px);overflow:auto;color:white;text-align:center'
  root.hidden = true
  const qr = document.createElement('div')
  qr.dataset.bindingQr = ''
  qr.setAttribute('role', 'img')
  qr.setAttribute('aria-label', '微信绑定二维码')
  qr.style.cssText = `width:100%;opacity:0;transition:opacity ${FADE_MS}ms ease`
  qr.style.aspectRatio = '1'
  const status = document.createElement('p')
  const form = document.createElement('form')
  const input = document.createElement('input')
  input.setAttribute('aria-label', '微信验证码')
  input.autocomplete = 'one-time-code'
  input.inputMode = 'numeric'
  input.style.cssText = 'box-sizing:border-box;width:100%;padding:9px'
  const submit = document.createElement('button')
  submit.type = 'submit'
  submit.textContent = '提交验证码'
  const verification = document.createElement('p')
  const dismiss = document.createElement('button')
  dismiss.type = 'button'
  dismiss.dataset.bindingDismiss = ''
  dismiss.textContent = '关闭'
  for (const button of [submit, dismiss]) {
    button.style.cssText = 'border:0;border-radius:8px;padding:9px 16px;margin:4px;background:#ff671d;color:white;cursor:pointer'
  }
  form.append(input, submit)
  form.hidden = true
  root.append(qr, status, form, verification, dismiss)
  container.append(root)

  let current: ChannelBindingSnapshot | undefined
  let disposed = false
  let generation = 0
  let targetQr: string | null = null
  let transition: ReturnType<typeof setTimeout> | undefined
  let appearance: ReturnType<typeof setTimeout> | undefined
  let hiding: ReturnType<typeof setTimeout> | undefined
  let success: ReturnType<typeof setTimeout> | undefined

  function showQr(text: string | null) {
    if (targetQr === text) return
    targetQr = text
    clearTimeout(transition)
    clearTimeout(appearance)
    qr.style.opacity = '0'
    const replace = () => {
      qr.replaceChildren()
      if (!text || disposed) return
      try {
        qr.append(qrSvg(text))
        appearance = setTimeout(() => { qr.style.opacity = '1' }, 16)
      } catch {
        status.textContent = '二维码无法显示，请重试'
      }
    }
    if (qr.childElementCount) transition = setTimeout(replace, FADE_MS)
    else replace()
  }

  function hide() {
    generation++
    input.value = ''
    form.hidden = true
    showQr(null)
    clearTimeout(hiding)
    hiding = setTimeout(() => { root.hidden = true }, FADE_MS)
  }

  const onDismiss = () => {
    if (disposed) return
    if (current) workflow.cancel(current.operation_id)
    hide()
  }
  const onSubmit = async (event: Event) => {
    event.preventDefault()
    if (disposed || form.hidden || submit.disabled || !input.value.trim()) return
    const owner = generation
    const code = input.value
    input.value = ''
    submit.disabled = true
    verification.textContent = ''
    try {
      const result = await workflow.verify(code)
      if (!disposed && generation === owner) {
        verification.textContent = result.accepted ? '验证码已提交' : '验证码未通过，请重试'
      }
    } catch {
      if (!disposed && generation === owner) verification.textContent = '验证码提交失败，请重试'
    } finally {
      if (!disposed && generation === owner) submit.disabled = false
    }
  }
  dismiss.addEventListener('click', onDismiss)
  form.addEventListener('submit', onSubmit)

  return {
    update(snapshot: ChannelBindingSnapshot) {
      if (disposed) return
      generation++
      clearTimeout(hiding)
      clearTimeout(success)
      const sameOperation = current?.operation_id === snapshot.operation_id
      current = snapshot
      input.value = ''
      submit.disabled = false
      verification.textContent = ''
      status.textContent = messages[snapshot.state]
      root.hidden = false
      form.hidden = snapshot.state !== 'verification' || !snapshot.verification
      if (snapshot.state === 'cancelled') { hide(); return }
      const terminal = snapshot.state === 'bound' || snapshot.state === 'failed'
      showQr(terminal ? null : snapshot.qr_url || (sameOperation ? targetQr : null))
      if (snapshot.state === 'bound') success = setTimeout(hide, 3000)
    },
    error(error: ChannelBindingError) {
      if (disposed) return
      root.hidden = false
      status.textContent = error.message
    },
    dispose() {
      if (disposed) return
      disposed = true
      generation++
      for (const timer of [transition, appearance, hiding, success]) clearTimeout(timer)
      input.value = ''
      dismiss.removeEventListener('click', onDismiss)
      form.removeEventListener('submit', onSubmit)
      root.remove()
    },
  }
}
