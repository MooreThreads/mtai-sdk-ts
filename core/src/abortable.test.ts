import { abortable, child, withChild } from './abortable'

it('never invokes work on an already aborted parent', async () => {
  const parent = abortable()
  parent.abort()
  const work = jest.fn(async () => 1)
  await expect(withChild(parent, work)).rejects.toThrow('connection aborted')
  expect(work).not.toHaveBeenCalled()
})

it('notifies late subscribers once and never revives an aborted child', () => {
  const parent = abortable()
  const [scope] = child(parent)
  parent.abort()
  const handler = jest.fn()
  scope.onabort(handler)
  expect(handler).toHaveBeenCalledTimes(1)
  scope.abort()
  parent.abort()
  expect(handler).toHaveBeenCalledTimes(1)
})

it.each([false, true])('unregisters parent subscription after settlement (failure=%s)', async failure => {
  const unregister = jest.fn()
  const parent = { abort: jest.fn(), onabort: jest.fn(() => unregister) }
  const outcome = withChild(parent, async () => {
    if (failure) throw new Error('failed')
    return 1
  })
  if (failure) await expect(outcome).rejects.toThrow('failed')
  else await expect(outcome).resolves.toBe(1)
  expect(unregister).toHaveBeenCalledTimes(1)
})

it('keeps a successful returned resource alive', async () => {
  const cleanup = jest.fn()
  await withChild(abortable(), async scope => { scope.onabort(cleanup) })
  expect(cleanup).not.toHaveBeenCalled()
})
