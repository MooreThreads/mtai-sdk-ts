import type { FrameCover } from './textureReceiver'

const vertexSource = `attribute vec2 position; varying vec2 uv;
void main(){gl_Position=vec4(position,0.,1.);uv=vec2((position.x+1.)*.5,(1.-position.y)*.5);}`
const fragmentSource = `precision mediump float; varying vec2 uv; uniform sampler2D image; uniform bool bottomOrigin;
void main(){vec2 source=vec2(uv.x,bottomOrigin?1.-uv.y:uv.y);gl_FragColor=vec4(texture2D(image,source).rgb,1.);}`

/** Independent GPU texture retains the last copied image for redraw after
 * source release. No readback, per-frame finish, rAF or visibility prerequisite.
 * Actual pixel/orientation parity requires separate hardware qualification. */
export class WebGLCover implements FrameCover {
  private gl: WebGLRenderingContext
  private program?: WebGLProgram
  private texture?: WebGLTexture
  private buffer?: WebGLBuffer
  private shaders: WebGLShader[] = []
  private bottomOrigin: WebGLUniformLocation | null = null
  private hasImage = false
  private failed = false
  private disposed = false
  private loss = (event: Event) => { event.preventDefault(); this.fail(new Error('avatar WebGL context lost')) }

  constructor(private canvas: HTMLCanvasElement, private onFailure: (error: Error) => void) {
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: false })
    if (!gl) throw new Error('avatar WebGL unavailable')
    this.gl = gl
    canvas.addEventListener('webglcontextlost', this.loss)
    try {
      const shader = (kind: number, source: string) => {
        const value = gl.createShader(kind); if (!value) throw new Error('avatar shader allocation failed')
        this.shaders.push(value); gl.shaderSource(value, source); gl.compileShader(value)
        if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(value) ?? 'avatar shader compile failed')
        return value
      }
      const program = gl.createProgram(); if (!program) throw new Error('avatar program allocation failed')
      this.program = program
      gl.attachShader(program, shader(gl.VERTEX_SHADER, vertexSource)); gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fragmentSource))
      gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'avatar shader link failed')
      gl.useProgram(program)
      const buffer = gl.createBuffer(), texture = gl.createTexture()
      if (buffer) this.buffer = buffer
      if (texture) this.texture = texture
      if (!buffer || !texture) throw new Error('avatar storage allocation failed')
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
      const position = gl.getAttribLocation(program, 'position')
      if (position < 0) throw new Error('avatar shader position missing')
      gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
      this.bottomOrigin = gl.getUniformLocation(program, 'bottomOrigin')
      const image = gl.getUniformLocation(program, 'image')
      if (!this.bottomOrigin || !image) throw new Error('avatar shader uniforms missing')
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture); gl.uniform1i(image, 0)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      this.check()
    } catch (error) { this.dispose(); throw error }
  }

  submit(frame: VideoFrame, rowOrigin: number): void {
    try {
      this.check()
      if (rowOrigin !== 1 && rowOrigin !== 2) throw new Error('unsupported avatar row orientation')
      const gl = this.gl
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texture!)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame)
      gl.uniform1i(this.bottomOrigin, rowOrigin === 2 ? 1 : 0)
      this.draw(); this.check(); this.hasImage = true
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); throw error }
  }

  resize(width: number, height: number): void {
    try {
      this.check()
      if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) throw new Error('invalid avatar canvas dimensions')
      if (this.canvas.width !== width) this.canvas.width = width
      if (this.canvas.height !== height) this.canvas.height = height
      if (this.hasImage) { this.draw(); this.check() }
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); throw error }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.canvas.removeEventListener('webglcontextlost', this.loss)
    const gl = this.gl
    if (this.texture) { gl.deleteTexture(this.texture); this.texture = undefined }
    if (this.buffer) { gl.deleteBuffer(this.buffer); this.buffer = undefined }
    if (this.program) { gl.useProgram(null); gl.deleteProgram(this.program); this.program = undefined }
    for (const shader of this.shaders) gl.deleteShader(shader)
    this.shaders = []; this.hasImage = false
  }
  private draw() { this.gl.viewport(0, 0, this.canvas.width, this.canvas.height); this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4) }
  private check() {
    if (this.failed || this.disposed || this.gl.isContextLost() || this.gl.getError() !== this.gl.NO_ERROR) throw new Error('avatar WebGL unhealthy')
  }
  private fail(error: Error) { if (this.failed || this.disposed) return; this.failed = true; try { this.onFailure(error) } catch { /* failure observer only */ } }
}
