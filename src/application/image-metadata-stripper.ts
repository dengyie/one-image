export interface MetadataStripResult {
  blob: Blob
  removed: string[]
  changed: boolean
}

const JPEG_SOI = 0xffd8
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Removes supported metadata chunks without decoding or re-encoding pixels. */
export async function stripImageMetadata(file: Blob, mime = file.type): Promise<MetadataStripResult> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  // Windows 与部分工具会给 JPEG 打非标准的 image/jpg；按实际容器解释。
  const normalized = mime === 'image/jpg' ? 'image/jpeg' : mime.toLowerCase()
  const detectedMime = isJpeg(bytes) ? 'image/jpeg' : isPng(bytes) ? 'image/png' : isWebp(bytes) ? 'image/webp' : null
  if (!detectedMime) {
    if (normalized === 'image/jpeg') return stripJpeg(bytes, normalized)
    if (normalized === 'image/png') return stripPng(bytes, normalized)
    if (normalized === 'image/webp') return stripWebp(bytes, normalized)
    throw new Error('当前格式不支持无损隐私元数据清理；请先导出为 JPEG、PNG 或 WebP')
  }
  if (normalized && normalized !== detectedMime) throw new Error('文件声明格式与实际图片容器不匹配，已取消清理')
  if (detectedMime === 'image/jpeg') return stripJpeg(bytes, detectedMime)
  if (detectedMime === 'image/png') return stripPng(bytes, detectedMime)
  return stripWebp(bytes, detectedMime)
}

function stripJpeg(bytes: Uint8Array, mime: string): MetadataStripResult {
  if (bytes.length < 4 || readU16(bytes, 0) !== JPEG_SOI) throw new Error('JPEG 文件头无效或文件已截断')
  const chunks: Uint8Array[] = [bytes.subarray(0, 2)]
  const removed = new Set<string>()
  let offset = 2
  let sawScan = false
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error('JPEG marker stream 无效')
    while (offset < bytes.length && bytes[offset] === 0xff) offset++
    if (offset >= bytes.length) throw new Error('JPEG marker 不完整')
    const marker = bytes[offset++]
    if (marker === 0xd9) {
      if (offset !== bytes.length) throw new Error('JPEG EOI 后包含尾随数据')
      chunks.push(bytes.subarray(offset - 2, offset))
      if (!sawScan) throw new Error('JPEG 缺少图像扫描数据')
      return result(chunks, removed, mime)
    }
    if (marker === 0xda) {
      if (offset + 2 > bytes.length) throw new Error('JPEG SOS 段已截断')
      const length = readU16(bytes, offset)
      if (length < 2 || offset + length > bytes.length) throw new Error('JPEG SOS 长度无效')
      chunks.push(bytes.subarray(offset - 2, offset + length))
      offset += length
      const scanEnd = findJpegScanEnd(bytes, offset)
      chunks.push(bytes.subarray(offset, scanEnd.dataEnd))
      offset = scanEnd.markerOffset
      sawScan = true
      continue
    }
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) {
      chunks.push(bytes.subarray(offset - 2, offset))
      continue
    }
    if (offset + 2 > bytes.length) throw new Error('JPEG 段长度已截断')
    const length = readU16(bytes, offset)
    if (length < 2 || offset + length > bytes.length) throw new Error('JPEG 段长度无效')
    const segment = bytes.subarray(offset - 2, offset + length)
    const payload = bytes.subarray(offset + 2, offset + length)
    const kind = jpegMetadataKind(marker, payload)
    if (kind) {
      if (kind === 'EXIF') assertExifOrientationSafe(payload.subarray(6))
      removed.add(kind)
    } else {
      chunks.push(segment)
    }
    offset += length
  }
  throw new Error('JPEG 缺少 EOI 标记')
}

function stripPng(bytes: Uint8Array, mime: string): MetadataStripResult {
  if (!startsWith(bytes, PNG_SIGNATURE)) throw new Error('PNG 文件头无效或文件已截断')
  const chunks: Uint8Array[] = [bytes.subarray(0, PNG_SIGNATURE.length)]
  const removed = new Set<string>()
  let offset = PNG_SIGNATURE.length
  let sawIhdr = false
  let sawIdat = false
  let sawIend = false
  while (offset + 12 <= bytes.length) {
    const length = readU32(bytes, offset)
    const end = offset + 12 + length
    if (end > bytes.length) throw new Error('PNG chunk 已截断')
    const typeBytes = bytes.subarray(offset + 4, offset + 8)
    const type = ascii(typeBytes)
    const payload = bytes.subarray(offset + 8, offset + 8 + length)
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== readU32(bytes, offset + 8 + length)) {
      throw new Error(`PNG ${type} chunk CRC 无效`)
    }
    if (type === 'IHDR') {
      if (sawIhdr || offset !== PNG_SIGNATURE.length || length !== 13) throw new Error('PNG IHDR 无效')
      sawIhdr = true
    }
    if (type === 'IDAT') sawIdat = true
    if (type === 'IEND') {
      if (length !== 0) throw new Error('PNG IEND 无效')
      sawIend = true
    }
    const kind = pngMetadataKind(type, payload)
    if (kind) {
      if (kind === 'EXIF') assertExifOrientationSafe(payload)
      removed.add(kind)
    } else {
      chunks.push(bytes.subarray(offset, end))
    }
    offset = end
    if (sawIend) break
  }
  if (!sawIhdr || !sawIdat || !sawIend) throw new Error('PNG 缺少有效 IHDR、IDAT 或 IEND')
  if (offset !== bytes.length) throw new Error('PNG 尾部包含无效数据')
  return result(chunks, removed, mime)
}

function stripWebp(bytes: Uint8Array, mime: string): MetadataStripResult {
  if (!isWebp(bytes)) throw new Error('WebP 文件头无效或文件已截断')
  const chunks: Uint8Array[] = [bytes.subarray(0, 12)]
  const removed = new Set<string>()
  let offset = 12
  let sawImage = false
  let vp8xFlagsOffset = -1
  let clearExifFlag = false
  let clearXmpFlag = false
  while (offset + 8 <= bytes.length) {
    const size = readU32LE(bytes, offset + 4)
    const payloadEnd = offset + 8 + size
    const chunkEnd = payloadEnd + (size & 1)
    if (chunkEnd > bytes.length) throw new Error('WebP chunk 已截断')
    const type = ascii(bytes.subarray(offset, offset + 4))
    const payload = bytes.subarray(offset + 8, payloadEnd)
    if (type === 'VP8 ' || type === 'VP8L' || type === 'ALPH') sawImage = true
    if (type === 'VP8X') {
      if (size !== 10 || vp8xFlagsOffset !== -1) throw new Error('WebP VP8X chunk 无效')
      vp8xFlagsOffset = 12 + chunks.slice(1).reduce((sum, chunk) => sum + chunk.length, 0) + 8
      sawImage = true
      chunks.push(bytes.subarray(offset, chunkEnd))
      offset = chunkEnd
      continue
    }
    const kind = webpMetadataKind(type)
    if (kind) {
      if (kind === 'EXIF') assertExifOrientationSafe(payload.subarray(startsWithAscii(payload, 'Exif\0\0') ? 6 : 0))
      removed.add(kind)
      if (kind === 'EXIF') clearExifFlag = true
      if (kind === 'XMP') clearXmpFlag = true
    } else {
      chunks.push(bytes.subarray(offset, chunkEnd))
    }
    offset = chunkEnd
  }
  if (offset !== bytes.length || !sawImage) throw new Error('WebP 缺少有效图像 chunk')
  if ((clearExifFlag || clearXmpFlag) && vp8xFlagsOffset < 0) throw new Error('WebP 元数据缺少 VP8X feature flags，拒绝修改')
  const output = joinChunks(chunks)
  if (vp8xFlagsOffset >= 0) {
    if (clearExifFlag) output[vp8xFlagsOffset] &= ~0x08
    if (clearXmpFlag) output[vp8xFlagsOffset] &= ~0x04
  }
  writeU32LE(output, 4, output.length - 8)
  return { blob: new Blob([toBlobPart(output)], { type: mime }), removed: [...removed], changed: removed.size > 0 }
}

function result(chunks: Uint8Array[], removed: Set<string>, mime: string): MetadataStripResult {
  return { blob: new Blob([toBlobPart(joinChunks(chunks))], { type: mime }), removed: [...removed], changed: removed.size > 0 }
}

function jpegMetadataKind(marker: number, payload: Uint8Array): string | null {
  if (marker === 0xe1 && startsWithAscii(payload, 'Exif\0\0')) return 'EXIF'
  if (marker === 0xe1 && startsWithAscii(payload, 'http://ns.adobe.com/xap/1.0/')) return 'XMP'
  if (marker === 0xeb && startsWithAscii(payload, 'JP') && containsAscii(payload, 'jumb')) return 'C2PA'
  return null
}

function pngMetadataKind(type: string, payload: Uint8Array): string | null {
  if (type === 'eXIf') return 'EXIF'
  if (type === 'caBX') return 'C2PA'
  if (type === 'iTXt' || type === 'tEXt' || type === 'zTXt') {
    const keyword = readNullTerminatedAscii(payload).toLowerCase()
    if (keyword === 'xml:com.adobe.xmp' || keyword === 'xmp') return 'XMP'
  }
  return null
}

function webpMetadataKind(type: string): string | null {
  if (type === 'EXIF') return 'EXIF'
  if (type === 'XMP ') return 'XMP'
  if (type === 'JUMBF') return 'C2PA'
  return null
}

function assertExifOrientationSafe(tiff: Uint8Array): void {
  if (tiff.length < 8) throw new Error('EXIF TIFF header 无效，拒绝清理以避免改变图像方向')
  const littleEndian = tiff[0] === 0x49 && tiff[1] === 0x49
  const bigEndian = tiff[0] === 0x4d && tiff[1] === 0x4d
  if (!littleEndian && !bigEndian) throw new Error('EXIF byte order 无效，拒绝清理以避免改变图像方向')
  const u16 = (offset: number) => littleEndian ? tiff[offset] | tiff[offset + 1] << 8 : tiff[offset] << 8 | tiff[offset + 1]
  const u32 = (offset: number) => littleEndian
    ? (tiff[offset] | tiff[offset + 1] << 8 | tiff[offset + 2] << 16 | tiff[offset + 3] << 24) >>> 0
    : readU32(tiff, offset)
  if (u16(2) !== 42) throw new Error('EXIF TIFF marker 无效，拒绝清理以避免改变图像方向')
  const ifdOffset = u32(4)
  if (ifdOffset + 2 > tiff.length) throw new Error('EXIF IFD0 已截断，拒绝清理以避免改变图像方向')
  const entries = u16(ifdOffset)
  if (ifdOffset + 2 + entries * 12 > tiff.length) throw new Error('EXIF IFD0 entries 已截断，拒绝清理以避免改变图像方向')
  for (let i = 0; i < entries; i++) {
    const entry = ifdOffset + 2 + i * 12
    if (u16(entry) !== 0x0112) continue
    if (u16(entry + 2) !== 3 || u32(entry + 4) !== 1) throw new Error('EXIF orientation 无法安全读取，拒绝清理')
    if (u16(entry + 8) !== 1) throw new Error('图片包含旋转/镜像 EXIF 方向；为避免改变显示效果，已取消元数据清理')
  }
}

function findJpegScanEnd(bytes: Uint8Array, start: number): { dataEnd: number; markerOffset: number } {
  for (let i = start; i < bytes.length - 1; i++) {
    if (bytes[i] !== 0xff) continue
    const next = bytes[i + 1]
    if (next === 0x00 || next === 0xff) continue
    if (next >= 0xd0 && next <= 0xd7) { i++; continue }
    return { dataEnd: i, markerOffset: i }
  }
  throw new Error('JPEG 扫描数据缺少后续 marker')
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function joinChunks(chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length }
  return output
}

function isJpeg(bytes: Uint8Array): boolean { return bytes.length >= 2 && readU16(bytes, 0) === JPEG_SOI }
function isPng(bytes: Uint8Array): boolean { return startsWith(bytes, PNG_SIGNATURE) }
function isWebp(bytes: Uint8Array): boolean { return bytes.length >= 12 && ascii(bytes.subarray(0, 4)) === 'RIFF' && ascii(bytes.subarray(8, 12)) === 'WEBP' }
function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean { return prefix.every((value, index) => bytes[index] === value) }
function startsWithAscii(bytes: Uint8Array, value: string): boolean {
  if (bytes.length < value.length) return false
  for (let i = 0; i < value.length; i++) if (bytes[i] !== value.charCodeAt(i)) return false
  return true
}
function containsAscii(bytes: Uint8Array, value: string): boolean {
  for (let start = 0; start <= bytes.length - value.length; start++) if (startsWithAscii(bytes.subarray(start), value)) return true
  return false
}
function readNullTerminatedAscii(bytes: Uint8Array): string {
  const end = bytes.indexOf(0)
  const limit = end < 0 ? Math.min(bytes.length, 128) : Math.min(end, 128)
  let value = ''
  for (let i = 0; i < limit; i++) value += String.fromCharCode(bytes[i])
  return value
}
function ascii(bytes: Uint8Array): string { let value = ''; for (const byte of bytes) value += String.fromCharCode(byte); return value }
function readU16(bytes: Uint8Array, offset: number): number { return (bytes[offset] << 8) | bytes[offset + 1] }
function readU32(bytes: Uint8Array, offset: number): number { return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3] }
function readU32LE(bytes: Uint8Array, offset: number): number { return (bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16 | bytes[offset + 3] << 24) >>> 0 }
function writeU32LE(out: Uint8Array, offset: number, value: number): void {
  out[offset] = value & 0xff
  out[offset + 1] = (value >>> 8) & 0xff
  out[offset + 2] = (value >>> 16) & 0xff
  out[offset + 3] = (value >>> 24) & 0xff
}
function toBlobPart(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
