import fs from 'node:fs'
import path from 'node:path'
import { decodeLocalMedia, encodeLocalMedia, LocalMediaProtocolError, type LocalMediaRecord } from './localMediaProtocol'

type Vector = { name: string, kind: LocalMediaRecord['kind'], target: LocalMediaRecord['target'],
  fields: Record<string, unknown>, hex: string }
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/local-media-v1.json'), 'utf8')) as {
  u64Fields: string[], vectors: Vector[],
}
function record(vector: Vector): LocalMediaRecord {
  const fields = Object.fromEntries(Object.entries(vector.fields).map(([key, value]) => [key,
    fixture.u64Fields.includes(key) ? BigInt(value as string) : key === 'pcm' ? Uint8Array.from(value as number[]) : value]))
  return { kind: vector.kind, target: vector.target, ...fields } as LocalMediaRecord
}

test.each(fixture.vectors.map(v => [v.name, v] as const))('independent wire bytes and lossless fields: %s', (_, vector) => {
  const expected = record(vector), wire = Buffer.from(vector.hex, 'hex')
  expect(Buffer.from(encodeLocalMedia(expected)).toString('hex')).toBe(vector.hex)
  const actual = decodeLocalMedia(wire)
  expect(actual.kind).toBe(expected.kind)
  expect(actual.target).toEqual(expected.target)
  for (const field of Object.keys(vector.fields)) {
    if (field === 'pcm') expect(Array.from((actual as any)[field])).toEqual(Array.from((expected as any)[field]))
    else expect((actual as any)[field]).toEqual((expected as any)[field])
  }
})

function invalid(defect: string) {
  let data = Buffer.from(fixture.vectors[0].hex, 'hex')
  if (defect === 'magic') data[0] ^= 1
  else if (defect === 'version') data[4] = 2
  else if (defect === 'kind') data[6] = 99
  else if (defect === 'length') data[8] ^= 1
  else if (defect === 'header') return data.subarray(0, 15)
  else if (defect === 'utf8') data[20] = 255
  else if (defect === 'string-length') data.fill(255, 16, 20)
  else if (defect === 'trailing') { data = Buffer.concat([data, Buffer.from('x')]); data.writeBigUInt64LE(BigInt(data.byteLength - 16), 8) }
  else if (defect === 'bool') { data = Buffer.from(fixture.vectors[4].hex, 'hex'); data[39] = 2 }
  return data
}

test.each(['magic', 'version', 'kind', 'length', 'header', 'utf8', 'string-length', 'trailing', 'bool'])(
  'malformed bytes are not a record: %s', defect => {
    expect(() => decodeLocalMedia(invalid(defect))).toThrow(LocalMediaProtocolError)
  },
)

test.each([
  ['negative', -1n], ['overflow', 1n << 64n], ['unsafe-number', 9007199254740992],
])('u64 does not clamp/coerce: %s', (_, value) => {
  expect(() => encodeLocalMedia({ kind: 'ready', target: { sessionId: 's', generation: 'g', attachment: 'a' },
    allocation: value as bigint })).toThrow(LocalMediaProtocolError)
})

test.each([null, ''])('optional turn presence is preserved: %s', turnId => {
  const value: LocalMediaRecord = { kind: 'state', target: { sessionId: 's', generation: 'g', attachment: 'a' },
    effectiveFrame: 1n, snapshot: true, turnId, audioActive: false }
  const actual = decodeLocalMedia(encodeLocalMedia(value))
  if (actual.kind !== 'state') throw new Error('STATE expected')
  expect(actual.turnId).toBe(turnId)
})

test('decoded PCM survives input-buffer reuse', () => {
  const bytes = Buffer.from(fixture.vectors[5].hex, 'hex'), value = decodeLocalMedia(bytes)
  bytes.fill(0)
  if (value.kind !== 'frame') throw new Error('FRAME expected')
  expect(Array.from(value.pcm)).toEqual([0, 128, 255, 127])
  expect(value.sequence).toBe(9007199254740993n)
})

test('unknown kind cannot resolve through an inherited object property', () => {
  expect(() => encodeLocalMedia({ kind: 'toString', target: { sessionId: 's', generation: 'g', attachment: 'a' } } as any))
    .toThrow(LocalMediaProtocolError)
})

test('encoder refuses unpaired UTF-16 instead of silently replacing source text', () => {
  expect(() => encodeLocalMedia({ kind: 'attach', target: { sessionId: '\ud800', generation: 'g', attachment: 'a' } }))
    .toThrow(LocalMediaProtocolError)
})
