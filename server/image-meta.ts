// Read-only container inspection for the imagegen adapters.
//
// The browser learns an image's size by decoding it, but the server only ever
// holds opaque bytes. Aggregators happily ignore a requested `size` (gpt-image
// returned 1254×1254 for a 1024×1024 request), so the honest thing to report
// is the size the file actually has — read from the container header, without
// decoding pixels and without pulling an image codec into the server bundle.
//
// The rewrite paths live in src/application/image-metadata-stripper.ts; this
// module only parses. Keep it forgiving: malformed input returns null instead
// of throwing, because the caller's job is to degrade to "size unknown".

export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp'

export interface ImageMeta {
  mimeType: ImageMimeType
  width: number
  height: number
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function readU16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1]
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
}

function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function readU24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset + length > bytes.length) return ''
  let out = ''
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i])
  return out
}

function hasPngSignature(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
}

function hasJpegSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
}

function hasWebpSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP'
}

function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  // Signature, then the mandatory first chunk: length(4) type(4) data...
  if (bytes.length < 24) return null
  if (ascii(bytes, 12, 4) !== 'IHDR') return null
  if (readU32BE(bytes, 8) !== 13) return null
  const width = readU32BE(bytes, 16)
  const height = readU32BE(bytes, 20)
  return width > 0 && height > 0 ? { width, height } : null
}

// SOF markers carry the frame size. C4 (DHT), C8 (JPG) and CC (DAC) share the
// 0xCn range but are not frame headers.
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  let offset = 2
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return null
    const marker = bytes[offset + 1]
    // Padding fill bytes are legal between segments.
    if (marker === 0xff) {
      offset += 1
      continue
    }
    // Standalone markers carry no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2
      continue
    }
    // Start of scan / end of image before any frame header: nothing to read.
    if (marker === 0xda || marker === 0xd9) return null
    const length = readU16BE(bytes, offset + 2)
    if (length < 2) return null
    if (JPEG_SOF.has(marker)) {
      if (offset + 9 >= bytes.length) return null
      const height = readU16BE(bytes, offset + 5)
      const width = readU16BE(bytes, offset + 7)
      return width > 0 && height > 0 ? { width, height } : null
    }
    offset += 2 + length
  }
  return null
}

function webpSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 20) return null
  const chunk = ascii(bytes, 12, 4)
  if (chunk === 'VP8X') {
    // flags(1) reserved(3) canvas width-1(3) canvas height-1(3)
    if (bytes.length < 30) return null
    // Canvas size is stored as 24-bit (value - 1) after the one-byte flags
    // and three reserved bytes.
    const width = readU24LE(bytes, 24) + 1
    const height = readU24LE(bytes, 27) + 1
    return width > 0 && height > 0 ? { width, height } : null
  }
  if (chunk === 'VP8 ') {
    // 3-byte frame tag, 3-byte start code (0x9d 0x01 0x2a), then 14-bit sizes.
    if (bytes.length < 30) return null
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null
    const width = readU16LE(bytes, 26) & 0x3fff
    const height = readU16LE(bytes, 28) & 0x3fff
    return width > 0 && height > 0 ? { width, height } : null
  }
  if (chunk === 'VP8L') {
    // signature byte 0x2f, then 14-bit (width-1) and 14-bit (height-1)
    if (bytes.length < 25) return null
    if (bytes[20] !== 0x2f) return null
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)
    const width = (bits & 0x3fff) + 1
    const height = ((bits >>> 14) & 0x3fff) + 1
    return width > 0 && height > 0 ? { width, height } : null
  }
  return null
}

/** Identifies the container and reads its pixel dimensions, or null if unsupported/truncated. */
export function sniffImage(bytes: Uint8Array): ImageMeta | null {
  if (hasPngSignature(bytes)) {
    const size = pngSize(bytes)
    return size ? { mimeType: 'image/png', ...size } : null
  }
  if (hasJpegSignature(bytes)) {
    const size = jpegSize(bytes)
    return size ? { mimeType: 'image/jpeg', ...size } : null
  }
  if (hasWebpSignature(bytes)) {
    const size = webpSize(bytes)
    return size ? { mimeType: 'image/webp', ...size } : null
  }
  return null
}

/** Decodes canonical base64 (whitespace tolerated) and reads its dimensions. */
export function sniffBase64Image(base64: string): ImageMeta | null {
  try {
    return sniffImage(Buffer.from(base64, 'base64'))
  } catch {
    return null
  }
}
