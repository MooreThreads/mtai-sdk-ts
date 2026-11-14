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
it.each(['frame', 'import'])('failed %s retirement retains custody for explicit retry only', async defect => {
  const f = fixture()
  if (defect === 'frame') f.close.mockImplementationOnce(() => { throw Error('close failure') })
  else f.release.mockImplementationOnce(() => { throw Error('release failure') })
  f.receiver.receive(f.imported, message())
  expect(f.submitted).not.toHaveBeenCalled(); expect(f.failed).toHaveBeenCalledTimes(1)
  expect(defect === 'frame' ? f.close : f.release).toHaveBeenCalledTimes(1)
  await f.receiver.close()
  expect(defect === 'frame' ? f.close : f.release).toHaveBeenCalledTimes(2)
})
it('close reentry during GPU work fences submission and joins cleanup', async () => {
  const f = fixture(); let closing!: Promise<void>
  f.submit.mockImplementation(() => { closing = f.receiver.close() })
  f.receiver.receive(f.imported, message()); await closing
  expect(f.close).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalledTimes(1); expect(f.submitted).not.toHaveBeenCalled()
})
it('a close waiting in the same receive does not retry a new cleanup failure', async () => {
  const f = fixture(); let closing!: Promise<void>
  f.submit.mockImplementation(() => { closing = f.receiver.close() })
  f.release.mockImplementationOnce(() => { throw Error('new cleanup failure') })
  f.receiver.receive(f.imported, message()); await expect(closing).rejects.toThrow()
  expect(f.release).toHaveBeenCalledTimes(1); await f.receiver.close(); expect(f.release).toHaveBeenCalledTimes(2)
})
it('submission observer throw fails only this receiver after real source retirement', async () => {
  const f = fixture(); f.submitted.mockImplementation(() => { throw Error('IPC failure') })
  f.receiver.receive(f.imported, message()); await f.receiver.close()
  expect(f.failed).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalledTimes(1)
})
it('explicit cleanup retry reentry joins the registered attempt without duplicate release', async () => {
  const f = fixture(); f.release.mockImplementationOnce(() => { throw Error('first release failure') })
  f.receiver.receive(f.imported, message())
  let reentered!: Promise<void>
  f.release.mockImplementationOnce(() => { reentered = f.receiver.close() })
  const closing = f.receiver.close(); await closing; await reentered
  expect(f.release).toHaveBeenCalledTimes(2); expect(f.submitted).not.toHaveBeenCalled()
})
it('nested cleanup failure is not retried by a close waiting on the outer receive', async () => {
  const f = fixture(), nestedRelease = jest.fn((): void => { throw Error('nested release failure') })
  let closing!: Promise<void>
  f.failed.mockImplementation(() => { closing = f.receiver.close() })
  f.submit.mockImplementation(() => f.receiver.receive({ getVideoFrame: () => f.frame, release: nestedRelease }, message(2n)))
  f.receiver.receive(f.imported, message())
  await expect(closing).rejects.toThrow('nested release failure')
  expect(nestedRelease).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalledTimes(1)
  nestedRelease.mockImplementation(() => undefined)
  await f.receiver.close(); expect(nestedRelease).toHaveBeenCalledTimes(2); expect(f.submitted).not.toHaveBeenCalled()
})
it('one retained owner failure does not prevent retirement of another independent owner', async () => {
  const f = fixture(), nestedRelease = jest.fn((): void => { throw Error('nested failed') })
  f.release.mockImplementation(() => { throw Error('outer failed') })
  f.submit.mockImplementation(() => f.receiver.receive({ getVideoFrame: () => f.frame, release: nestedRelease }, message(2n)))
  f.receiver.receive(f.imported, message()); expect(f.release).toHaveBeenCalledTimes(1); expect(nestedRelease).toHaveBeenCalledTimes(1)
  nestedRelease.mockImplementation(() => undefined)
  await expect(f.receiver.close()).rejects.toThrow('outer failed')
  expect(f.release).toHaveBeenCalledTimes(2); expect(nestedRelease).toHaveBeenCalledTimes(2)
  f.release.mockImplementation(() => undefined); await f.receiver.close()
  expect(f.release).toHaveBeenCalledTimes(3); expect(nestedRelease).toHaveBeenCalledTimes(2)
})

it('explicit retirement reentry never revisits a newly failed nested owner in the same attempt', async () => {
  const f = fixture(), nestedRelease = jest.fn((): void => { throw Error('new nested failure') })
  f.release.mockImplementationOnce(() => { throw Error('initial failure') })
  f.receiver.receive(f.imported, message())
  f.release.mockImplementationOnce(() => f.receiver.receive({ getVideoFrame: () => f.frame, release: nestedRelease }, message(2n)))
  await expect(f.receiver.close()).rejects.toThrow('new nested failure')
  expect(nestedRelease).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalledTimes(2)
  nestedRelease.mockImplementation(() => undefined); await f.receiver.close()
  expect(nestedRelease).toHaveBeenCalledTimes(2); expect(f.release).toHaveBeenCalledTimes(2)
  expect(f.submitted).not.toHaveBeenCalled()
})

it('a waiter registered inside submit can explicitly retry immediately after cleanup rejection', async () => {
  const f = fixture(); let waiter!: Promise<void>
  f.release.mockImplementationOnce(() => { throw Error('release once') })
  f.submit.mockImplementation(() => {
    waiter = (async () => { try { await f.receiver.close() } catch { await f.receiver.close() } })()
  })
  f.receiver.receive(f.imported, message()); await waiter
  expect(f.release).toHaveBeenCalledTimes(2); expect(f.submitted).not.toHaveBeenCalled()
})

it('nested receive fails without abandoning either imported owner', async () => {
  const f = fixture(), release = jest.fn()
  f.submit.mockImplementation(() => f.receiver.receive({ getVideoFrame: () => f.frame, release }, message(2n)))
  f.receiver.receive(f.imported, message()); await f.receiver.close()
  expect(release).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalledTimes(1); expect(f.submitted).not.toHaveBeenCalled()
})
