import { TURN_STRIPE_HEIGHT } from './turnStripe'

export type StripePixels = { data: ArrayLike<number>, width: number, height: number }
export type StripeReadbackTiming = {
  import_start_ms: number, import_end_ms: number,
  submission_start_ms: number, submission_end_ms: number,
  ready_observed_ms: number | null,
  copy_start_ms: number, copy_end_ms: number,
  synchronous_drain: boolean,
}
export type StripeReadbackSample<C> = { image: StripePixels, context: C, timing: StripeReadbackTiming }

/** Resource owner only. Scheduling, saturation decisions and turn state belong to the observer. */
export interface AvatarStripeReadback<C> {
  /** Capture the current video stripe before any potentially blocking retirement. */
  prepare(): boolean
  /** Enqueue the prepared stripe using a free slot; never implicitly wait or drop. */
  submit(context: C): void
  retireReady(): StripeReadbackSample<C>[]
  /** The user-approved saturation exception; may block inside getBufferSubData. */
  retireOldestBlocking(): StripeReadbackSample<C> | null
  readonly pending: number
  dispose(): void
}

const VERTEX = `#version 300 es
void main() {
  vec2 p = gl_VertexID == 0 ? vec2(-1., -1.) : gl_VertexID == 1 ? vec2(3., -1.) : vec2(-1., 3.);
  gl_Position = vec4(p, 0., 1.);
}`
const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D videoTexture;
out vec4 color;
void main() { color = texelFetch(videoTexture, ivec2(gl_FragCoord.xy), 0); }`

type Slot = { buffer: WebGLBuffer, bytes: number }
type Prepared = { width: number, importStart: number, importEnd: number, submissionStart: number }
type Pending<C> = Prepared & { slot: Slot, fence: WebGLSync, context: C, submissionEnd: number }

/** Two PBOs, full stripe, CPU decoder. No timer, wait deadline, third slot or recovery loop. */
export function createAvatarStripeReadback<C>(video: HTMLVideoElement): AvatarStripeReadback<C> | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  let gl: WebGL2RenderingContext | null = null
  let disposed = false, lost = false
  const buffers: Slot[] = [], pending: Pending<C>[] = []
  const shaders: WebGLShader[] = []
  const textures: WebGLTexture[] = []
  let program: WebGLProgram | null = null, framebuffer: WebGLFramebuffer | null = null
  let source: WebGLTexture, target: WebGLTexture
  let prepared: Prepared | undefined
  let targetWidth = 0
  const onLost = () => { lost = true }
  canvas.addEventListener('webglcontextlost', onLost)

  function dispose() {
    if (disposed) return
    disposed = true
    canvas.removeEventListener('webglcontextlost', onLost)
    prepared = undefined
    if (gl) {
      for (const item of pending) gl.deleteSync(item.fence)
      for (const slot of buffers) gl.deleteBuffer(slot.buffer)
      for (const texture of textures) gl.deleteTexture(texture)
      for (const shader of shaders) gl.deleteShader(shader)
      if (program) gl.deleteProgram(program)
      if (framebuffer) gl.deleteFramebuffer(framebuffer)
      // This dedicated off-DOM context belongs exclusively to this instance.
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
    pending.length = 0
  }
  function requireContext(): WebGL2RenderingContext {
    if (disposed || lost || !gl || gl.isContextLost()) throw new Error('stripe_readback_unavailable')
    return gl
  }
  function check(g: WebGL2RenderingContext) {
    if (g.isContextLost() || g.getError() !== g.NO_ERROR) throw new Error('stripe_readback_failed')
  }
  function texture(g: WebGL2RenderingContext) {
    const t = g.createTexture()
    if (!t) throw new Error('stripe_texture_unavailable')
    textures.push(t)
    g.bindTexture(g.TEXTURE_2D, t)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE)
    return t
  }
  try {
    gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, alpha: false })
    const g = requireContext()
    function shader(type: number, text: string) {
      const s = g.createShader(type)
      if (!s) throw new Error('stripe_shader_unavailable')
      shaders.push(s)
      g.shaderSource(s, text); g.compileShader(s)
      if (!g.getShaderParameter(s, g.COMPILE_STATUS)) throw new Error('stripe_shader_failed')
      return s
    }
    program = g.createProgram()
    if (!program) throw new Error('stripe_program_unavailable')
    g.attachShader(program, shader(g.VERTEX_SHADER, VERTEX))
    g.attachShader(program, shader(g.FRAGMENT_SHADER, FRAGMENT))
    g.linkProgram(program)
    if (!g.getProgramParameter(program, g.LINK_STATUS)) throw new Error('stripe_program_failed')
    g.useProgram(program)
    g.uniform1i(g.getUniformLocation(program, 'videoTexture'), 0)
    g.disable(g.BLEND); g.disable(g.DITHER); g.disable(g.DEPTH_TEST); g.disable(g.SCISSOR_TEST)
    g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, false)
    g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    g.pixelStorei(g.UNPACK_COLORSPACE_CONVERSION_WEBGL, g.BROWSER_DEFAULT_WEBGL)
    source = texture(g); target = texture(g)
    framebuffer = g.createFramebuffer()
    if (!framebuffer) throw new Error('stripe_framebuffer_unavailable')
    g.bindFramebuffer(g.FRAMEBUFFER, framebuffer)
    g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, target, 0)
    for (let i = 0; i < 2; i++) {
      const buffer = g.createBuffer()
      if (!buffer) throw new Error('stripe_buffer_unavailable')
      buffers.push({ buffer, bytes: 0 })
    }
    check(g)
  } catch {
    dispose()
    return null
  }

  function take(blocking: boolean): StripeReadbackSample<C> | null {
    const g = requireContext(), item = pending[0]
    if (!item) return null
    let ready: number | null = null
    if (!blocking) {
      const status = g.clientWaitSync(item.fence, 0, 0)
      if (status === g.TIMEOUT_EXPIRED) return null
      if (status !== g.ALREADY_SIGNALED && status !== g.CONDITION_SATISFIED) throw new Error('stripe_fence_failed')
      ready = performance.now()
    }
    const start = performance.now()
    const data = new Uint8Array(item.width * TURN_STRIPE_HEIGHT * 4)
    g.bindBuffer(g.PIXEL_PACK_BUFFER, item.slot.buffer)
    g.getBufferSubData(g.PIXEL_PACK_BUFFER, 0, data)
    const end = performance.now()
    check(g)
    pending.shift()
    g.deleteSync(item.fence)
    return { image: { data, width: item.width, height: TURN_STRIPE_HEIGHT }, context: item.context,
      timing: { import_start_ms: item.importStart, import_end_ms: item.importEnd,
        submission_start_ms: item.submissionStart, submission_end_ms: item.submissionEnd,
        ready_observed_ms: ready, copy_start_ms: start, copy_end_ms: end, synchronous_drain: blocking } }
  }
  return {
    prepare() {
      const g = requireContext()
      prepared = undefined
      const width = video.videoWidth
      if (!width || video.videoHeight < TURN_STRIPE_HEIGHT) return false
      const start = performance.now()
      if (width !== targetWidth) {
        canvas.width = width; canvas.height = TURN_STRIPE_HEIGHT
        g.bindTexture(g.TEXTURE_2D, target)
        g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, width, TURN_STRIPE_HEIGHT, 0, g.RGBA, g.UNSIGNED_BYTE, null)
        if (g.checkFramebufferStatus(g.FRAMEBUFFER) !== g.FRAMEBUFFER_COMPLETE) throw new Error('stripe_framebuffer_failed')
        check(g)
        targetWidth = width
      }
      g.activeTexture(g.TEXTURE0)
      g.bindTexture(g.TEXTURE_2D, source)
      const importStart = performance.now()
      // Chromium/ANGLE on the measured host has a fast video path here;
      // texSubImage2D(video) was ~70 ms and is deliberately NOT substituted.
      g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, video)
      const importEnd = performance.now()
      g.viewport(0, 0, width, TURN_STRIPE_HEIGHT)
      // Without UNPACK_FLIP_Y, uploaded row zero is the source top row.
      // Render that row into framebuffer row zero; readPixels returns it first.
      g.drawArrays(g.TRIANGLES, 0, 3)
      // Do not add per-frame framebuffer/getError round trips here: they
      // defeated asynchronous submission in the measured implementation.
      // Validate allocations on resize and results when bytes are retrieved.
      prepared = { width, importStart, importEnd, submissionStart: start }
      return true
    },
    submit(context) {
      const g = requireContext()
      if (!prepared) throw new Error('stripe_not_prepared')
      const slot = buffers.find(b => !pending.some(p => p.slot === b))
      if (!slot) throw new Error('stripe_saturated')
      const captured = prepared
      g.bindBuffer(g.PIXEL_PACK_BUFFER, slot.buffer)
      const bytes = captured.width * TURN_STRIPE_HEIGHT * 4
      if (slot.bytes !== bytes) { g.bufferData(g.PIXEL_PACK_BUFFER, bytes, g.STREAM_READ); slot.bytes = bytes }
      g.readPixels(0, 0, captured.width, TURN_STRIPE_HEIGHT, g.RGBA, g.UNSIGNED_BYTE, 0)
      const fence = g.fenceSync(g.SYNC_GPU_COMMANDS_COMPLETE, 0)
      if (!fence) throw new Error('stripe_fence_unavailable')
      // Own the fence before any subsequent driver call can fail.
      const item = { ...captured, context, slot, fence, submissionEnd: 0 }
      pending.push(item)
      prepared = undefined
      g.flush()
      item.submissionEnd = performance.now()
    },
    retireReady() {
      const result: StripeReadbackSample<C>[] = []
      while (pending.length) {
        const sample = take(false)
        if (!sample) break
        result.push(sample)
      }
      return result
    },
    retireOldestBlocking: () => take(true),
    get pending() { return pending.length },
    dispose,
  }
}
