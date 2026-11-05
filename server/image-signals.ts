// Read-only metadata-signal inspection for the provenance route.
//
// The OpenAI provenance check is the authoritative signal source, but it is a
// paid upstream that can be down or disabled. These scans answer a weaker
// question from the raw bytes alone: does the container still carry provenance
// metadata segments (C2PA/JUMBF manifests, EXIF, XMP)? A hit is meaningful —
// grok writes C2PA into EXIF, Gemini writes JUMBF — while a miss proves
// nothing: pixel-level SynthID is not locally detectable at all.
//
// Parsing mirrors src/application/image-metadata-stripper.ts (which rewrites
// these same segments in the browser). This module never modifies bytes and,
// like image-meta.ts, degrades to null/empty on malformed input instead of
// throwing: the caller's job is to enrich a response, not to reject it.

export type MetadataSignalKind = 'C2PA' | 'EXIF' | 'XMP'

export interface MetadataSignal {
  kind: MetadataSignalKind
  /** Container segment where the signal was found, e.g. "jpeg:APP11". */
  location: string
  /** Bytes of the carrying segment/chunk (manifest size, not just the tag). */
  bytes: number
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset + length > bytes.length) return ''
  let out = ''
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i])
  return out
}

function startsWithAscii(payload: Uint8Array, text: string): boolean {
  if (payload.length < text.length) return false
  for (let i = 0; i < text.length; i++) {
    if (payload[i] !== text.charCodeAt(i)) return false
  }
  return true
}

function containsAscii(payload: Uint8Array, text: string): boolean {
  const bytes = Buffer.from(text, 'ascii')
  outer: for (let i = 0; i + text.length <= payload.length; i++) {
    for (let j = 0; j < bytes.length; j++) {
      if (payload[i + j] !== bytes[j]) continue outer
    }
    return true
  }
  return false
}

const JPEG_APP1_EXIF = 'Exif\0\0'
const JPEG_APP1_XMP = 'http://ns.adobe.com/xap/1.0/'
const JPEG_APP11_JUMBF = 'JP'

function scanJpeg(bytes: Uint8Array): MetadataSignal[] {
  const signals: MetadataSignal[] = []
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) break
    const marker = bytes[offset + 1]
    if (marker === 0xff) {
      offset += 1
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2
      continue
    }
    // Scan data starts here: metadata segments can only precede it.
    if (marker === 0xda) break
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3]
    if (length < 2) break
    const payload = bytes.subarray(offset + 4, Math.min(offset + 2 + length, bytes.length))
    if (marker === 0xe1) {
      if (startsWithAscii(payload, JPEG_APP1_EXIF)) signals.push({ kind: 'EXIF', location: 'jpeg:APP1', bytes: length })
      else if (startsWithAscii(payload, JPEG_APP1_XMP)) signals.push({ kind: 'XMP', location: 'jpeg:APP1', bytes: length })
    } else if (marker === 0xeb && startsWithAscii(payload, JPEG_APP11_JUMBF) && containsAscii(payload, 'jumb')) {
      signals.push({ kind: 'C2PA', location: 'jpeg:APP11', bytes: length })
    }
    offset += 2 + length
  }
  return signals
}

function pngChunkType(bytes: Uint8Array, offset: number): string {
  return ascii(bytes, offset, 4)
}

function scanPng(bytes: Uint8Array): MetadataSignal[] {
  const signals: MetadataSignal[] = []
  // Signature(8) then chunks: length(4) type(4) data length crc(4).
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const dataLength = ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
    const type = pngChunkType(bytes, offset + 4)
    const dataStart = offset + 8
    if (dataStart + dataLength + 4 > bytes.length) break // truncated: keep what we have
    const payload = bytes.subarray(dataStart, dataStart + dataLength)
    if (type === 'eXIf') {
      signals.push({ kind: 'EXIF', location: 'png:eXIf', bytes: dataLength })
    } else if (type === 'caBX') {
      signals.push({ kind: 'C2PA', location: 'png:caBX', bytes: dataLength })
    } else if (type === 'iTXt' || type === 'tEXt' || type === 'zTXt') {
      const keyword = readNullTerminatedAscii(payload).toLowerCase()
      if (keyword === 'xml:com.adobe.xmp' || keyword === 'xmp') {
        signals.push({ kind: 'XMP', location: `png:${type}`, bytes: dataLength })
      }
    }
    offset = dataStart + dataLength + 4
  }
  return signals
}

function readNullTerminatedAscii(payload: Uint8Array): string {
  const end = payload.indexOf(0)
  return ascii(payload, 0, end < 0 ? payload.length : end)
}

function scanWebp(bytes: Uint8Array): MetadataSignal[] {
  const signals: MetadataSignal[] = []
  // RIFF(4) size(4) WEBP(4), then chunks: fourcc(4) size(4) data padded to even.
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4)
    const size = bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24)
    if (size < 0 || offset + 8 + size > bytes.length) break
    if (type === 'EXIF') {
      signals.push({ kind: 'EXIF', location: 'webp:EXIF', bytes: size })
    } else if (type === 'XMP ') {
      signals.push({ kind: 'XMP', location: 'webp:XMP', bytes: size })
    } else if (type === 'JUMB' && size >= 8 && bytes[offset + 12] === 0x6a && bytes[offset + 13] === 0x75 && bytes[offset + 14] === 0x6d && bytes[offset + 15] === 0x62) {
      // RIFF fourcc values are four bytes, so the C2PA superbox chunk id is
      // 'JUMB' (C2PA spec) and the payload starts with a JUMBF box header:
      // length(4) then the superbox type 'jumb' (lowercase, ISO 19566-5).
      // Checking that inner type keeps a stray 'JUMB' word in image data from
      // triggering this branch.
      signals.push({ kind: 'C2PA', location: 'webp:JUMB(JUMBF)', bytes: size })
    }
    offset += 8 + size + (size % 2)
  }
  return signals
}

function hasPngSignature(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  )
}

function hasJpegSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
}

function hasWebpSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP'
}

/** Scans container metadata segments for provenance signals, or null for unsupported/truncated input. */
export function scanMetadataSignals(bytes: Uint8Array): MetadataSignal[] | null {
  if (hasJpegSignature(bytes)) return scanJpeg(bytes)
  if (hasPngSignature(bytes)) return scanPng(bytes)
  if (hasWebpSignature(bytes)) return scanWebp(bytes)
  return null
}
