import { deflateSync, inflateSync } from 'node:zlib'

// Minimal zero-dependency PNG codec for the server-side smart-erase surface.
// Scope is deliberately narrow: the only producer is our own browser client
// (canvas.toBlob('image/png')) and the only consumer is LaMa's RGBA plane, so
// the decoder supports 8-bit non-interlaced truecolor with or without alpha
// and the encoder always writes filter-0 RGBA. Anything else fails closed —
// a foreign PNG that decodes wrong would silently corrupt a user's picture.

export interface RgbaImage {
  width: number
  height: number
  rgba: Uint8Array
}

function readChunkSize(bytes: Buffer, offset: number): number {
  return bytes.readUInt32BE(offset)
}

/** Decodes 8-bit non-interlaced RGB/RGBA (color type 2/6) PNGs into RGBA. */
export function decodePngRgba(bytes: Buffer, options: { maxEdge?: number } = {}): RgbaImage | null {
  // Default matches the codec's own envelope; the smart-erase route passes
  // its stricter 2048 limit so an oversized header is rejected BEFORE the
  // inflate — a hostile high-ratio IDAT must never get to allocate.
  const maxEdge = options.maxEdge ?? 8192
  try {
    if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47) return null
    let offset = 8
    let width = 0
    let height = 0
    let bitDepth = 0
    let colorType = 0
    let interlace = 0
    let idat: Buffer[] = []
    while (offset + 8 <= bytes.length) {
      const length = readChunkSize(bytes, offset)
      const type = bytes.toString('latin1', offset + 4, offset + 8)
      const data = bytes.subarray(offset + 8, offset + 8 + length)
      if (type === 'IHDR') {
        width = data.readUInt32BE(0)
        height = data.readUInt32BE(4)
        bitDepth = data[8]
        colorType = data[9]
        interlace = data[12]
      } else if (type === 'IDAT') {
        idat.push(data)
      } else if (type === 'IEND') {
        break
      }
      offset += 12 + length
    }
    if (width <= 0 || height <= 0 || width > maxEdge || height > maxEdge) return null
    if (bitDepth !== 8 || interlace !== 0) return null
    if (colorType !== 6 && colorType !== 2) return null
    if (idat.length === 0) return null

    const hasAlpha = colorType === 6

    const channels = colorType === 6 ? 4 : 3
    const stride = width * channels
    // The raw stream is exactly (stride + 1) * height bytes for every PNG we
    // accept; capping the inflate there turns a decompression bomb into a
    // fast null instead of a multi-gigabyte allocation.
    const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * height })
    if (raw.length !== (stride + 1) * height) return null

    // Unfilter in place (PNG filters 0-4), then expand to RGBA.
    const filtered = Buffer.alloc(stride * height)
    let pos = 0
    for (let y = 0; y < height; y++) {
      const filter = raw[pos]
      pos += 1
      const row = raw.subarray(pos, pos + stride)
      pos += stride
      const out = y * stride
      const prev = (y - 1) * stride
      for (let x = 0; x < stride; x++) {
        const left = x >= channels ? filtered[out + x - channels] : 0
        const up = y > 0 ? filtered[prev + x] : 0
        const upLeft = y > 0 && x >= channels ? filtered[prev + x - channels] : 0
        let value = row[x]
        if (filter === 1) value += left
        else if (filter === 2) value += up
        else if (filter === 3) value += (left + up) >> 1
        else if (filter === 4) {
          const p = left + up - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - upLeft)
          value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
        }
        filtered[out + x] = value & 0xff
      }
    }

    const rgba = new Uint8Array(width * height * 4)
    for (let i = 0; i < width * height; i++) {
      if (hasAlpha) {
        rgba[i * 4] = filtered[i * 4]
        rgba[i * 4 + 1] = filtered[i * 4 + 1]
        rgba[i * 4 + 2] = filtered[i * 4 + 2]
        rgba[i * 4 + 3] = filtered[i * 4 + 3]
      } else {
        rgba[i * 4] = filtered[i * 3]
        rgba[i * 4 + 1] = filtered[i * 3 + 1]
        rgba[i * 4 + 2] = filtered[i * 3 + 2]
        rgba[i * 4 + 3] = 255
      }
    }
    return { width, height, rgba }
  } catch {
    return null
  }
}

function crc32(bytes: Buffer): number {
  let table = crc32Cache
  if (!table) {
    table = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
    crc32Cache = table
  }
  let crc = -1
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xff]
  return (crc ^ -1) >>> 0
}
let crc32Cache: Int32Array | null = null

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(data.length + 12)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** Encodes RGBA into an 8-bit RGBA PNG with filter 0 rows (deflate level 6). */
export function encodePngRgba(image: { width: number; height: number; rgba: Uint8Array }): Buffer {
  const { width, height, rgba } = image
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
