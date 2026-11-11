import { describe, expect, it } from 'vitest'
import { deflateSync } from 'node:zlib'
import { decodePngRgba, encodePngRgba } from '../server/png'

function pngWithDeclaredSize(width: number, height: number, idat: Buffer): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const out = Buffer.alloc(data.length + 12)
    out.writeUInt32BE(data.length, 0)
    out.write(type, 4, 'latin1')
    data.copy(out, 8)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

describe('decodePngRgba hardening', () => {
  it('returns null fast on a decompression bomb instead of allocating it', () => {
    // IHDR declares 2048×2048 (a legitimate-looking smart-erase crop) but the
    // IDAT inflates to 64MB — far past the (stride+1)*height envelope.
    const bomb = pngWithDeclaredSize(2048, 2048, deflateSync(Buffer.alloc(64 * 1024 * 1024)))
    const decoded = decodePngRgba(bomb, { maxEdge: 2048 })
    expect(decoded).toBeNull()
  })

  it('rejects an oversized header before inflating', () => {
    // 4096-edge header against a 2048 maxEdge: garbage IDAT would throw if
    // inflate were ever attempted; the size gate must answer first.
    const oversized = pngWithDeclaredSize(4096, 4096, Buffer.from([0x00, 0x01, 0x02, 0x03]))
    expect(decodePngRgba(oversized, { maxEdge: 2048 })).toBeNull()
  })

  it('still decodes valid images at the configured edge', () => {
    const rgba = new Uint8Array(2048 * 16 * 4)
    for (let i = 0; i < rgba.length; i++) rgba[i] = i % 251
    const valid = encodePngRgba({ width: 2048, height: 16, rgba })
    expect(decodePngRgba(valid, { maxEdge: 2048 })).not.toBeNull()
    const onePast = encodePngRgba({ width: 2049, height: 16, rgba: new Uint8Array(2049 * 16 * 4) })
    expect(decodePngRgba(onePast, { maxEdge: 2048 })).toBeNull()
  })
})
