import { describe, expect, it } from 'vitest'
import { sniffBase64Image, sniffImage } from '../server/image-meta'

function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(8 + 8 + 13 + 4)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0)
  header.writeUInt32BE(13, 8)
  header.write('IHDR', 12, 'latin1')
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  header[24] = 8 // bit depth
  header[25] = 6 // truecolour with alpha
  return header
}

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0])
  head.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([head, payload])
}

function jpeg(width: number, height: number, sofMarker = 0xc0): Buffer {
  const app0 = Buffer.concat([Buffer.from('JFIF\0', 'latin1'), Buffer.alloc(9)])
  const sof = Buffer.alloc(15)
  sof[0] = 8 // precision
  sof.writeUInt16BE(height, 1)
  sof.writeUInt16BE(width, 3)
  sof[5] = 3 // components
  for (let i = 0; i < 3; i++) {
    sof[6 + i * 3] = i + 1
    sof[7 + i * 3] = 0x11
    sof[8 + i * 3] = 0
  }
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xe0, app0),
    jpegSegment(sofMarker, sof),
    Buffer.from([0xff, 0xda, 0x00, 0x02]),
  ])
}

function webp(chunk: 'VP8X' | 'VP8 ' | 'VP8L', payload: Buffer): Buffer {
  const head = Buffer.alloc(12)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(4 + 8 + payload.length, 4)
  head.write('WEBP', 8, 'latin1')
  const chunkHead = Buffer.alloc(8)
  chunkHead.write(chunk, 0, 'latin1')
  chunkHead.writeUInt32LE(payload.length, 4)
  return Buffer.concat([head, chunkHead, payload])
}

function webpVp8x(width: number, height: number): Buffer {
  const payload = Buffer.alloc(10)
  payload.writeUIntLE(width - 1, 4, 3)
  payload.writeUIntLE(height - 1, 7, 3)
  return webp('VP8X', payload)
}

function webpVp8(width: number, height: number): Buffer {
  const payload = Buffer.alloc(10)
  payload[0] = 0x30 // frame tag; low bits are the scaling hint
  payload[1] = 0x01
  payload[2] = 0x00
  payload[3] = 0x9d
  payload[4] = 0x01
  payload[5] = 0x2a
  payload.writeUInt16LE(width, 6)
  payload.writeUInt16LE(height, 8)
  return webp('VP8 ', payload)
}

function webpVp8l(width: number, height: number): Buffer {
  const payload = Buffer.alloc(5)
  payload[0] = 0x2f
  payload.writeUInt32LE((width - 1) | ((height - 1) << 14), 1)
  return webp('VP8L', payload)
}

describe('image container metadata', () => {
  it('reads PNG dimensions from IHDR', () => {
    expect(sniffImage(png(1254, 1254))).toEqual({ mimeType: 'image/png', width: 1254, height: 1254 })
    expect(sniffImage(png(1536, 1024))).toEqual({ mimeType: 'image/png', width: 1536, height: 1024 })
  })

  it('reads baseline and progressive JPEG dimensions past leading segments', () => {
    expect(sniffImage(jpeg(768, 1152))).toEqual({ mimeType: 'image/jpeg', width: 768, height: 1152 })
    expect(sniffImage(jpeg(2176, 1632, 0xc2))).toEqual({ mimeType: 'image/jpeg', width: 2176, height: 1632 })
  })

  it('reads all three WebP layouts', () => {
    expect(sniffImage(webpVp8x(1920, 1080))).toEqual({ mimeType: 'image/webp', width: 1920, height: 1080 })
    expect(sniffImage(webpVp8(640, 480))).toEqual({ mimeType: 'image/webp', width: 640, height: 480 })
    expect(sniffImage(webpVp8l(512, 256))).toEqual({ mimeType: 'image/webp', width: 512, height: 256 })
  })

  it('returns null for truncated, empty and unrelated bytes instead of throwing', () => {
    expect(sniffImage(new Uint8Array())).toBeNull()
    expect(sniffImage(Buffer.from('not an image at all'))).toBeNull()
    expect(sniffImage(png(100, 100).subarray(0, 20))).toBeNull()
    expect(sniffImage(jpeg(100, 100).subarray(0, 12))).toBeNull()
    expect(sniffImage(webpVp8x(100, 100).subarray(0, 26))).toBeNull()
  })

  it('rejects a PNG whose first chunk is not IHDR', () => {
    const bytes = png(10, 10)
    bytes.write('IDAT', 12, 'latin1')
    expect(sniffImage(bytes)).toBeNull()
  })

  it('rejects a WebP lossy frame without the VP8 start code', () => {
    const bytes = webpVp8(320, 240)
    bytes[23] = 0x00
    expect(sniffImage(bytes)).toBeNull()
  })

  it('decodes base64 payloads and tolerates garbage', () => {
    expect(sniffBase64Image(png(64, 32).toString('base64'))).toEqual({ mimeType: 'image/png', width: 64, height: 32 })
    expect(sniffBase64Image('!!!not-base64!!!')).toBeNull()
  })
})
