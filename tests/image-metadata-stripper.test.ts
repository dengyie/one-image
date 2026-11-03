import { describe, expect, it } from 'vitest'
import { stripImageMetadata } from '../src/application/image-metadata-stripper'

const encoder = new TextEncoder()

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) { out.set(part, offset); offset += part.length }
  return out
}

function be32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255])
}

function le32(value: number): Uint8Array {
  return new Uint8Array([value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255])
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, payload: Uint8Array): Uint8Array {
  const typeBytes = encoder.encode(type)
  const body = concat(typeBytes, payload)
  return concat(be32(payload.length), body, be32(crc32(body)))
}

function jpegSegment(marker: number, payload: Uint8Array): Uint8Array {
  return concat(new Uint8Array([0xff, marker]), new Uint8Array([(payload.length + 2) >>> 8, (payload.length + 2) & 255]), payload)
}

function jpegFixture(): Uint8Array {
  const tiff = new Uint8Array([0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0])
  const exif = concat(encoder.encode('Exif\0\0'), tiff)
  const xmp = encoder.encode('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>')
  const icc = encoder.encode('ICC_PROFILE\0\x01\x01profile')
  const scan = new Uint8Array([0x12, 0x34, 0xff, 0x00, 0x56])
  return concat(
    new Uint8Array([0xff, 0xd8]),
    jpegSegment(0xe1, exif),
    jpegSegment(0xe1, xmp),
    jpegSegment(0xe2, icc),
    jpegSegment(0xda, new Uint8Array([])),
    scan,
    new Uint8Array([0xff, 0xd9]),
  )
}

function pngFixture(): Uint8Array {
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])
  const xmp = concat(encoder.encode('XML:com.adobe.xmp\0\0\0\0\0'), encoder.encode('<x:xmpmeta/>'))
  const pixelPayload = new Uint8Array([0x78, 0x9c, 0x63, 0x60, 0x60, 0x60, 0, 0, 0, 4, 0, 1])
  return concat(
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('sRGB', new Uint8Array([0])),
    pngChunk('eXIf', new Uint8Array([0x49, 0x49, 42, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    pngChunk('iTXt', xmp),
    pngChunk('IDAT', pixelPayload),
    pngChunk('IEND', new Uint8Array()),
  )
}

function webpFixture(): Uint8Array {
  const vp8xPayload = new Uint8Array([0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  const chunk = (type: string, payload: Uint8Array) => concat(encoder.encode(type), le32(payload.length), payload, payload.length % 2 ? new Uint8Array([0]) : new Uint8Array())
  const body = concat(
    encoder.encode('WEBP'),
    chunk('VP8X', vp8xPayload),
    chunk('VP8 ', new Uint8Array([1, 2, 3, 4])),
    chunk('EXIF', encoder.encode('Exif\0\0II*\0\x08\0\0\0\0\0\0\0')),
    chunk('XMP ', encoder.encode('<x:xmpmeta/>')),
  )
  return concat(encoder.encode('RIFF'), le32(body.length), body)
}

async function bytes(blob: Blob): Promise<Uint8Array> { return new Uint8Array(await blob.arrayBuffer()) }
function blobFromBytes(data: Uint8Array, type: string): Blob {
  return new Blob([data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer], { type })
}
function pngChunkBytes(data: Uint8Array, wanted: string): Uint8Array[] {
  const chunks: Uint8Array[] = []
  let offset = 8
  while (offset + 12 <= data.length) {
    const length = (data[offset] << 24) + (data[offset + 1] << 16) + (data[offset + 2] << 8) + data[offset + 3]
    const type = String.fromCharCode(...data.subarray(offset + 4, offset + 8))
    if (type === wanted) chunks.push(data.subarray(offset, offset + length + 12))
    offset += length + 12
    if (type === 'IEND') break
  }
  return chunks
}

function includes(haystack: Uint8Array, needle: string): boolean {
  const encoded = encoder.encode(needle)
  outer: for (let start = 0; start <= haystack.length - encoded.length; start++) {
    for (let i = 0; i < encoded.length; i++) if (haystack[start + i] !== encoded[i]) continue outer
    return true
  }
  return false
}

describe('stripImageMetadata', () => {
  it('removes JPEG EXIF and XMP while preserving ICC and compressed scan bytes', async () => {
    const original = jpegFixture()
    const cleaned = await stripImageMetadata(blobFromBytes(original, 'image/jpeg'))
    const output = await bytes(cleaned.blob)
    expect(cleaned.removed).toEqual(expect.arrayContaining(['EXIF', 'XMP']))
    expect(includes(output, 'Exif')).toBe(false)
    expect(includes(output, 'xmpmeta')).toBe(false)
    expect(includes(output, 'ICC_PROFILE')).toBe(true)
    expect(output.slice(-7)).toEqual(original.slice(-7))
    expect(cleaned.changed).toBe(true)
  })

  it('removes PNG EXIF/XMP while keeping color and IDAT chunks byte-identical', async () => {
    const original = pngFixture()
    const cleaned = await stripImageMetadata(blobFromBytes(original, 'image/png'))
    const output = await bytes(cleaned.blob)
    expect(cleaned.removed).toEqual(expect.arrayContaining(['EXIF', 'XMP']))
    expect(includes(output, 'eXIf')).toBe(false)
    expect(includes(output, 'xmpmeta')).toBe(false)
    expect(pngChunkBytes(output, 'sRGB')).toEqual(pngChunkBytes(original, 'sRGB'))
    expect(pngChunkBytes(output, 'IDAT')).toEqual(pngChunkBytes(original, 'IDAT'))
    expect(cleaned.changed).toBe(true)
  })

  it('removes WebP EXIF/XMP and updates RIFF metadata flags without changing image chunks', async () => {
    const original = webpFixture()
    const cleaned = await stripImageMetadata(blobFromBytes(original, 'image/webp'))
    const output = await bytes(cleaned.blob)
    expect(cleaned.removed).toEqual(expect.arrayContaining(['EXIF', 'XMP']))
    expect(includes(output, 'EXIF')).toBe(false)
    expect(includes(output, '<x:xmpmeta/>')).toBe(false)
    expect(includes(output, 'VP8 ')).toBe(true)
    expect(output[20] & 0x0c).toBe(0)
    expect(new DataView(output.buffer).getUint32(4, true)).toBe(output.length - 8)
  })

  it('returns byte-identical valid output when no removable metadata exists', async () => {
    const first = await stripImageMetadata(blobFromBytes(pngFixture(), 'image/png'))
    const original = await bytes(first.blob)
    const cleaned = await stripImageMetadata(first.blob)
    expect(cleaned.changed).toBe(false)
    expect(cleaned.removed).toEqual([])
    expect(await bytes(cleaned.blob)).toEqual(original)
  })

  it('treats the nonstandard image/jpg alias as JPEG instead of a container mismatch', async () => {
    const original = jpegFixture()
    const cleaned = await stripImageMetadata(blobFromBytes(original, 'image/jpg'))
    const output = await bytes(cleaned.blob)
    expect(cleaned.removed).toEqual(expect.arrayContaining(['EXIF', 'XMP']))
    expect(includes(output, 'xmpmeta')).toBe(false)
    expect(cleaned.changed).toBe(true)
  })

  it('rejects unsupported formats and truncated containers', async () => {
    await expect(stripImageMetadata(blobFromBytes(new Uint8Array([1, 2, 3]), 'image/avif'))).rejects.toThrow(/不支持/)
    await expect(stripImageMetadata(blobFromBytes(new Uint8Array([0xff, 0xd8, 0xff]), 'image/jpeg'))).rejects.toThrow(/截断|不完整/)
    await expect(stripImageMetadata(blobFromBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png'))).rejects.toThrow(/无效|截断/)
  })
})
