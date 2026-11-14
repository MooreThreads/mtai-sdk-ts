import { TextureReceiver, type ImportedVideo } from './textureReceiver'
import type { TextureMessage } from './mainTexture'
const target = { sessionId: 's', generation: 'g', attachment: 'a' }
const message = (sequence = 1n): TextureMessage => ({ identity: { ...target, allocation: 7n, sequence }, rowOrigin: 1 })
function fixture() {
  const submitted = jest.fn(), failed = jest.fn(), submit = jest.fn()
  const receiver = new TextureReceiver(target, 7n, 4, 3, { submit }, { submitted, failed })
  const close = jest.fn(), release = jest.fn()
  const frame = { displayWidth: 4, displayHeight: 3, close } as unknown as VideoFrame
  const imported: ImportedVideo = { getVideoFrame: jest.fn(() => frame), release }
  return { receiver, submitted, failed, submit, close, release, frame, imported }
}
it('submits healthy exact identity only after GPU copy/draw and both source releases', async () => {
  const f = fixture(), effects: string[] = []
  f.submit.mockImplementation(() => effects.push('cover'))
  f.close.mockImplementation(() => effects.push('frame closed'))
  f.release.mockImplementation(() => effects.push('import released'))
  f.submitted.mockImplementation(() => effects.push('submitted'))
  f.receiver.receive(f.imported, message())
  expect(effects).toEqual(['cover', 'frame closed', 'import released', 'submitted'])
  expect(f.submit).toHaveBeenCalledWith(f.frame, 1)
  await f.receiver.close(); expect(f.release).toHaveBeenCalledTimes(1); expect(f.failed).not.toHaveBeenCalled()
})
it('retains the cover independently after receiver close and accepts a separate replacement generation', async () => {
  const f = fixture(); f.receiver.receive(f.imported, message()); await f.receiver.close()
  const replacement = new TextureReceiver({ ...target, generation: 'g2' }, 8n, 4, 3, { submit: f.submit }, { submitted: f.submitted, failed: f.failed })
  replacement.receive(f.imported, { identity: { ...target, generation: 'g2', allocation: 8n, sequence: 1n }, rowOrigin: 2 })
  expect(f.submit).toHaveBeenLastCalledWith(f.frame, 2); expect(f.submitted).toHaveBeenCalledTimes(2); await replacement.close()
})
it.each(['generation', 'allocation', 'sequence', 'orientation', 'dimensions'])('rejects unmatched %s without healthy receipt and cleans imported owners', async defect => {
  const f = fixture(); let input = message()
  if (defect === 'generation') input = { ...input, identity: { ...input.identity, generation: 'old' } }
  if (defect === 'allocation') input = { ...input, identity: { ...input.identity, allocation: 9n } }
  if (defect === 'sequence') input = { ...input, identity: { ...input.identity, sequence: 2n } }
  if (defect === 'orientation') input = { ...input, rowOrigin: 0 }
  if (defect === 'dimensions') Object.assign(f.frame, { displayWidth: 99 })
  f.receiver.receive(f.imported, input); await f.receiver.close()
  expect(f.submitted).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledTimes(1); expect(f.failed).toHaveBeenCalledTimes(1)
})
it('GPU failure fences before cleanup, releases VideoFrame and import without reporting submission', async () => {
  const f = fixture(); f.submit.mockImplementation(() => { throw Error('GPU failed') })
  f.failed.mockImplementation(() => expect(f.submitted).not.toHaveBeenCalled())
  f.receiver.receive(f.imported, message()); await f.receiver.close()
  expect(f.close).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalledTimes(1); expect(f.submitted).not.toHaveBeenCalled()
})
it('getVideoFrame failure still releases imported ownership', async () => {
  const f = fixture(); f.imported.getVideoFrame = () => { throw Error('no frame') }
  f.receiver.receive(f.imported, message()); await f.receiver.close()
  expect(f.close).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledTimes(1); expect(f.submitted).not.toHaveBeenCalled()
})
it.each(['frame', 'import'])('uncertain %s release rejects retirement without fabricating success or retry', async defect => {
  const f = fixture()
  if (defect === 'frame') f.close.mockImplementationOnce(() => { throw Error('uncertain release') })
  else f.release.mockImplementationOnce(() => { throw Error('uncertain release') })
  f.receiver.receive(f.imported, message())
  await expect(f.receiver.close()).rejects.toThrow('uncertain release')
  await expect(f.receiver.close()).rejects.toThrow('uncertain release')
  expect(defect === 'frame' ? f.close : f.release).toHaveBeenCalledTimes(1)
  expect(f.submitted).not.toHaveBeenCalled()
})
it('close reentry during GPU work fences submission and joins cleanup', async () => {
  const f = fixture(); let closing!: Promise<void>
  f.submit.mockImplementation(() => { closing = f.receiver.close() })
  f.receiver.receive(f.imported, message()); await closing
  expect(f.close).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalledTimes(1); expect(f.submitted).not.toHaveBeenCalled()
})
it('submission observer throw fails only this receiver after real source retirement', async () => {
  const f = fixture(); f.submitted.mockImplementation(() => { throw Error('IPC failure') })
  f.receiver.receive(f.imported, message()); await f.receiver.close()
  expect(f.failed).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalledTimes(1)
})
