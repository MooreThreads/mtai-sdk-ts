/** @jest-environment jsdom */
import { WebGLCover } from './webglCover'
function fixture(options: { compile?: boolean, link?: boolean, texture?: boolean } = {}) {
  let lost = false, error = 0, currentProgram: object | null = null, deletedProgram = false
  const liveShaders = new Set<object>(), attachedShaders = new Set<object>()
  const reclaim = () => { if (deletedProgram && !currentProgram) attachedShaders.clear() }
  const shaders = [{ kind: 'vertex' }, { kind: 'fragment' }]
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4, ARRAY_BUFFER: 5, STATIC_DRAW: 6,
    FLOAT: 7, TEXTURE0: 8, TEXTURE_2D: 9, TEXTURE_MIN_FILTER: 10, TEXTURE_MAG_FILTER: 11, LINEAR: 12,
    TEXTURE_WRAP_S: 13, TEXTURE_WRAP_T: 14, CLAMP_TO_EDGE: 15, NO_ERROR: 0, RGBA: 16, UNSIGNED_BYTE: 17,
    UNPACK_FLIP_Y_WEBGL: 18, TRIANGLE_STRIP: 19,
    createShader: jest.fn(() => { const shader = shaders.shift()!; liveShaders.add(shader); return shader }), shaderSource: jest.fn(), compileShader: jest.fn(),
    getShaderParameter: jest.fn(() => options.compile !== false), getShaderInfoLog: () => 'compile failed',
    createProgram: () => ({}), attachShader: jest.fn((_program: object, shader: object) => attachedShaders.add(shader)), linkProgram: jest.fn(),
    getProgramParameter: () => options.link !== false, getProgramInfoLog: () => 'link failed', useProgram: jest.fn((program: object | null) => { currentProgram = program; reclaim() }),
    createBuffer: () => ({}), createTexture: () => options.texture === false ? null : {},
    bindBuffer: jest.fn(), bufferData: jest.fn(), getAttribLocation: () => 0, enableVertexAttribArray: jest.fn(), vertexAttribPointer: jest.fn(),
    getUniformLocation: (_program: unknown, name: string) => ({ name }), activeTexture: jest.fn(), bindTexture: jest.fn(),
    uniform1i: jest.fn(), texParameteri: jest.fn(), pixelStorei: jest.fn(), texImage2D: jest.fn(), viewport: jest.fn(), drawArrays: jest.fn(),
    isContextLost: () => lost, getError: () => { const result = error; error = 0; return result },
    deleteTexture: jest.fn(), deleteBuffer: jest.fn(), deleteProgram: jest.fn(() => { deletedProgram = true; reclaim() }), deleteShader: jest.fn((shader: object) => liveShaders.delete(shader)),
  }
  const canvas = document.createElement('canvas'); canvas.width = 4; canvas.height = 3
  canvas.getContext = jest.fn(() => gl) as unknown as HTMLCanvasElement['getContext']
  const failed = jest.fn()
  return { canvas, gl, failed, retainedGraphics: () => Boolean(currentProgram) || liveShaders.size !== 0 || attachedShaders.size !== 0,
    lose: () => { lost = true; canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true })) },
    error: () => { error = 1282 }, create: () => new WebGLCover(canvas, failed) }
}
it('copies into independent texture and redraws retained cover without another source upload', () => {
  const f = fixture(), cover = f.create(), frame = {} as VideoFrame
  cover.submit(frame, 1)
  expect(f.gl.texImage2D).toHaveBeenCalledWith(f.gl.TEXTURE_2D, 0, f.gl.RGBA, f.gl.RGBA, f.gl.UNSIGNED_BYTE, frame)
  expect(f.gl.drawArrays).toHaveBeenCalledTimes(1)
  cover.resize(8, 6); expect(f.canvas.width).toBe(8); expect(f.canvas.height).toBe(6)
  expect(f.gl.drawArrays).toHaveBeenCalledTimes(2); expect(f.gl.texImage2D).toHaveBeenCalledTimes(1)
  cover.dispose(); cover.dispose(); expect(f.gl.deleteTexture).toHaveBeenCalledTimes(1)
  expect(f.gl.deleteBuffer).toHaveBeenCalledTimes(1); expect(f.gl.deleteProgram).toHaveBeenCalledTimes(1); expect(f.gl.deleteShader).toHaveBeenCalledTimes(2); expect(f.retainedGraphics()).toBe(false)
})
it('keeps blank initial resize independent of first source, and passes explicit origin to shader', () => {
  const f = fixture(), cover = f.create()
  cover.resize(8, 6); expect(f.gl.drawArrays).not.toHaveBeenCalled()
  cover.submit({} as VideoFrame, 2)
  expect(f.gl.uniform1i).toHaveBeenLastCalledWith({ name: 'bottomOrigin' }, 1)
  cover.dispose()
})
it.each([{ compile: false }, { link: false }, { texture: false }])('preparation failure releases all allocated graphics owners', options => {
  const f = fixture(options)
  expect(() => f.create()).toThrow(); expect(f.gl.deleteProgram).toHaveBeenCalledTimes(1)
  expect(f.gl.deleteShader.mock.calls.length).toBeGreaterThan(0); expect(f.retainedGraphics()).toBe(false)
})
it('actual upload/draw error reports failure and refuses future use, not healthy submission', () => {
  const f = fixture(), cover = f.create()
  f.gl.drawArrays.mockImplementationOnce(() => f.error())
  expect(() => cover.submit({} as VideoFrame, 1)).toThrow('unhealthy')
  expect(f.failed).toHaveBeenCalledTimes(1); expect(() => cover.resize(8, 6)).toThrow()
  cover.dispose()
})
it('context loss fails once and invalidates retained cover without readback/recovery', () => {
  const f = fixture(), cover = f.create(); cover.submit({} as VideoFrame, 1)
  f.lose(); f.lose(); expect(f.failed).toHaveBeenCalledTimes(1)
  expect(() => cover.submit({} as VideoFrame, 1)).toThrow(); cover.dispose()
})
