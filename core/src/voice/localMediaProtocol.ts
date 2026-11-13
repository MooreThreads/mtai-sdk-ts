/** Local SOCK_SEQPACKET wire v1. Portable bytes only: no native/Electron imports.
 * Normative contract: DH2D docs/local-media-protocol-v1.md.
 */
export class LocalMediaProtocolError extends Error {}
export type AttachmentKey = { readonly sessionId: string, readonly generation: string, readonly attachment: string }
export type Layout = {
  allocation: bigint, width: number, height: number, fourcc: number,
  stride: bigint, offset: bigint, modifier: bigint, extent: bigint,
  rowOrigin: number, colorSpace: number, sampleRate: number, channels: number, sampleFormat: number,
}
export type OutputState = { effectiveFrame: bigint, snapshot: boolean, turnId: string | null, audioActive: boolean }
export type MediaFrame = {
  sequence: bigint, allocation: bigint, rendererFrame: bigint, producedNs: bigint,
  sampleStart: bigint, sampleCount: bigint, pcm: Uint8Array,
}
export type LocalMediaRecord = { target: AttachmentKey } & (
  | { kind: 'attach' }
  | ({ kind: 'layout' } & Layout)
  | { kind: 'ready' | 'attached', allocation: bigint }
  | ({ kind: 'state' } & OutputState)
  | ({ kind: 'frame' } & MediaFrame)
  | { kind: 'reuseAck', sequence: bigint, allocation: bigint, submissionReceiptNs: bigint,
      phaseOriginNs: bigint, phaseRevision: bigint, phaseEffectiveFrame: bigint }
  | { kind: 'eos', lastSequence: bigint, totalSamples: bigint }
  | { kind: 'detach', lastSequence: bigint, reason: string }
  | { kind: 'failure', code: number, message: string }
  | { kind: 'cancel', request: bigint, throughSequence: bigint, turnId: string | null }
  | { kind: 'retired', request: bigint, throughSequence: bigint }
)
export const ABGR8888 = 0x34324241
const VERSION = 1
const HEADER_BYTES = 16
const MAGIC = [0x44, 0x32, 0x4c, 0x4d]
type Encoding = 'u8' | 'u16' | 'u32' | 'u64' | 'bool' | 'string' | 'optional' | 'blob'
type Schema = readonly (readonly [string, Encoding])[]
const schemas: Readonly<Record<LocalMediaRecord['kind'], { code: number, fields: Schema }>> = {
  attach: { code: 1, fields: [] },
  layout: { code: 2, fields: [
    ['allocation', 'u64'], ['width', 'u32'], ['height', 'u32'], ['fourcc', 'u32'],
    ['stride', 'u64'], ['offset', 'u64'], ['modifier', 'u64'], ['extent', 'u64'],
    ['rowOrigin', 'u8'], ['colorSpace', 'u8'], ['sampleRate', 'u32'],
    ['channels', 'u16'], ['sampleFormat', 'u16'],
  ] },
  ready: { code: 3, fields: [['allocation', 'u64']] },
  attached: { code: 4, fields: [['allocation', 'u64']] },
  state: { code: 5, fields: [['effectiveFrame', 'u64'], ['snapshot', 'bool'], ['turnId', 'optional'], ['audioActive', 'bool']] },
  frame: { code: 6, fields: [['sequence', 'u64'], ['allocation', 'u64'], ['rendererFrame', 'u64'], ['producedNs', 'u64'],
    ['sampleStart', 'u64'], ['sampleCount', 'u64'], ['pcm', 'blob']] },
  reuseAck: { code: 7, fields: [['sequence', 'u64'], ['allocation', 'u64'], ['submissionReceiptNs', 'u64'],
    ['phaseOriginNs', 'u64'], ['phaseRevision', 'u64'], ['phaseEffectiveFrame', 'u64']] },
  eos: { code: 8, fields: [['lastSequence', 'u64'], ['totalSamples', 'u64']] },
  detach: { code: 9, fields: [['lastSequence', 'u64'], ['reason', 'string']] },
  failure: { code: 10, fields: [['code', 'u32'], ['message', 'string']] },
  cancel: { code: 11, fields: [['request', 'u64'], ['throughSequence', 'u64'], ['turnId', 'optional']] },
  retired: { code: 12, fields: [['request', 'u64'], ['throughSequence', 'u64']] },
}
const fail = (message: string): never => { throw new LocalMediaProtocolError(message) }
const integerBytes = { u8: 1, u16: 2, u32: 4, u64: 8 } as const

class Writer {
  private parts: Uint8Array[] = []
  write(value: unknown, encoding: Encoding) {
    if (encoding === 'optional') {
      this.write(value !== null && value !== undefined, 'bool')
      if (value !== null && value !== undefined) this.write(value, 'string')
    } else if (encoding === 'bool') {
      if (typeof value !== 'boolean') fail('boolean required')
      this.parts.push(Uint8Array.of(value ? 1 : 0))
    } else if (encoding === 'string') {
      if (typeof value !== 'string' || /[\uD800-\uDFFF]/u.test(value)) fail('valid UTF-8 string required')
      const data = new TextEncoder().encode(value as string)
      this.write(data.byteLength, 'u32')
      this.parts.push(data)
    } else if (encoding === 'blob') {
      if (!(value instanceof Uint8Array)) fail('byte buffer required')
      const data = value as Uint8Array
      this.write(BigInt(data.byteLength), 'u64')
      this.parts.push(data)
    } else {
      const size = integerBytes[encoding]
      const data = new Uint8Array(size), view = new DataView(data.buffer)
      if (encoding === 'u64') {
        if (typeof value !== 'bigint' || value < 0n || value > 0xffffffffffffffffn) fail('u64 bigint required')
        view.setBigUint64(0, value as bigint, true)
      } else {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= 2 ** (size * 8)) {
          fail('integer is not representable in wire field')
        }
        if (encoding === 'u8') view.setUint8(0, value as number)
        else if (encoding === 'u16') view.setUint16(0, value as number, true)
        else view.setUint32(0, value as number, true)
      }
      this.parts.push(data)
    }
  }
  bytes() {
    const data = new Uint8Array(this.parts.reduce((size, part) => size + part.byteLength, 0))
    let offset = 0
    for (const part of this.parts) { data.set(part, offset); offset += part.byteLength }
    return data
  }
}

class Reader {
  private offset = 0
  constructor(private data: Uint8Array) {}
  take(size: bigint | number) {
    const count = typeof size === 'bigint' ? size : BigInt(size)
    if (count < 0n || count > BigInt(this.data.byteLength - this.offset)) fail('truncated record')
    const start = this.offset
    this.offset += Number(count) // bounded by the actual existing buffer, not a policy ceiling
    return this.data.subarray(start, this.offset)
  }
  get remaining() { return this.data.byteLength - this.offset }
  read(encoding: Encoding): unknown {
    if (encoding === 'optional') return this.read('bool') ? this.read('string') : null
    if (encoding === 'bool') {
      const value = this.read('u8')
      if (value !== 0 && value !== 1) fail('invalid boolean')
      return value === 1
    }
    if (encoding === 'string') {
      const data = this.take(this.read('u32') as number)
      try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data) }
      catch { return fail('invalid UTF-8 string') }
    }
    if (encoding === 'blob') return this.take(this.read('u64') as bigint).slice()
    const data = this.take(integerBytes[encoding]), view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    if (encoding === 'u8') return view.getUint8(0)
    if (encoding === 'u16') return view.getUint16(0, true)
    if (encoding === 'u32') return view.getUint32(0, true)
    return view.getBigUint64(0, true)
  }
}

export function encodeLocalMedia(record: LocalMediaRecord): Uint8Array {
  if (!Object.prototype.hasOwnProperty.call(schemas, record.kind)) return fail('unsupported record kind')
  const schema = schemas[record.kind]
  const body = new Writer()
  for (const value of [record.target.sessionId, record.target.generation, record.target.attachment]) body.write(value, 'string')
  const fields = record as unknown as Record<string, unknown>
  for (const [name, encoding] of schema.fields) body.write(fields[name], encoding)
  const payload = body.bytes(), header = new Writer()
  for (const byte of MAGIC) header.write(byte, 'u8')
  header.write(VERSION, 'u16'); header.write(schema.code, 'u16'); header.write(BigInt(payload.byteLength), 'u64')
  const data = new Uint8Array(HEADER_BYTES + payload.byteLength)
  data.set(header.bytes()); data.set(payload, HEADER_BYTES)
  return data
}

export function decodeLocalMedia(bytes: Uint8Array): LocalMediaRecord {
  if (!(bytes instanceof Uint8Array)) return fail('byte buffer required')
  // Buffer is a Uint8Array subclass whose slice() aliases memory. Always make
  // an actual owned byte copy before returning decoded data asynchronously.
  const reader = new Reader(new Uint8Array(bytes))
  for (const byte of MAGIC) if (reader.read('u8') !== byte) return fail('unsupported local media protocol')
  if (reader.read('u16') !== VERSION) return fail('unsupported local media protocol')
  const code = reader.read('u16')
  const entry = Object.entries(schemas).find(([, schema]) => schema.code === code)
  if (!entry) return fail('unsupported record kind')
  if (reader.read('u64') !== BigInt(reader.remaining)) return fail('record length mismatch')
  const target = { sessionId: reader.read('string') as string, generation: reader.read('string') as string,
    attachment: reader.read('string') as string }
  const fields: Record<string, unknown> = {}
  for (const [name, encoding] of entry[1].fields) fields[name] = reader.read(encoding)
  if (reader.remaining !== 0) return fail('trailing record bytes')
  return { kind: entry[0], target, ...fields } as LocalMediaRecord
}
