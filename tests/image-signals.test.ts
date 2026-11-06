import { describe, expect, it } from 'vitest'
import { scanMetadataSignals } from '../server/image-signals'

// Minimal container builders, same spirit as tests/image-meta.test.ts.

function jpegWithSegments(segments: Array<{ marker: number; payload: Uint8Array }>): Uint8Array {
  // APP0 JFIF: length(2) 'JFIF\0'(5) version(2) units(1) density(4) thumbnail(2) = 16 total.
  const parts: number[] = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]
  for (const seg of segments) {
    parts.push(0xff, seg.marker, (seg.payload.length + 2) >> 8, (seg.payload.length + 2) & 0xff)
    for (const b of seg.payload) parts.push(b)
  }
  parts.push(0xff, 0xda, 0x00, 0x02) // SOS — scan data follows, metadata cannot appear after it
  parts.push(0x00, 0x01, 0x02)
  return new Uint8Array(parts)
}

function pngWithChunks(chunks: Array<{ type: string; data: Uint8Array }>): Uint8Array {
  const parts: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (const chunk of chunks) {
    const len = chunk.data.length
    parts.push((len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff)
    for (let i = 0; i < 4; i++) parts.push(chunk.type.charCodeAt(i))
    for (const b of chunk.data) parts.push(b)
    parts.push(0, 0, 0, 0) // CRC (not verified by the scanner)
  }
  return new Uint8Array(parts)
}

function webpWithChunks(chunks: Array<{ type: string; data: Uint8Array }>): Uint8Array {
  const body: number[] = []
  for (const chunk of chunks) {
    for (let i = 0; i < 4; i++) body.push(chunk.type.charCodeAt(i))
    const size = chunk.data.length
    body.push(size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >> 24) & 0xff)
    for (const b of chunk.data) body.push(b)
    if (size % 2 === 1) body.push(0) // RIFF chunks are padded to even length
  }
  const size = 4 + body.length
  return new Uint8Array([
    0x52, 0x49, 0x46, 0x46, // RIFF
    size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >> 24) & 0xff,
    0x57, 0x45, 0x42, 0x50, // WEBP
    ...body,
  ])
}

const ascii = (text: string): Uint8Array => new Uint8Array([...text].map((c) => c.charCodeAt(0)))

describe('scanMetadataSignals', () => {
  it('finds EXIF and XMP in JPEG APP1 segments', () => {
    const jpeg = jpegWithSegments([
      { marker: 0xe1, payload: new Uint8Array([...ascii('Exif\0\0'), ...ascii('MM\x00*\x00\x00\x00\x08')]) },
      { marker: 0xe1, payload: new Uint8Array([...ascii('http://ns.adobe.com/xap/1.0/\0'), ...ascii('<x:xmpmeta/>')]) },
    ])
    expect(scanMetadataSignals(jpeg)!.signals).toEqual([
      { kind: 'EXIF', location: 'jpeg:APP1', bytes: 2 + 14 },
      { kind: 'XMP', location: 'jpeg:APP1', bytes: 2 + 41 },
    ])
  })

  it('finds a C2PA JUMBF manifest in JPEG APP11', () => {
    const jpeg = jpegWithSegments([
      { marker: 0xeb, payload: new Uint8Array([...ascii('JP'), ...ascii('some jumb box data here')]) },
    ])
    expect(scanMetadataSignals(jpeg)!.signals).toEqual([{ kind: 'C2PA', location: 'jpeg:APP11', bytes: 27 }])
  })

  it('does not mistake an ordinary APP1 for EXIF', () => {
    const jpeg = jpegWithSegments([
      { marker: 0xe1, payload: ascii('ICC_PROFILE\0whatever') },
    ])
    expect(scanMetadataSignals(jpeg)!.signals).toEqual([])
  })

  it('stops at the JPEG scan marker — metadata after SOS cannot appear', () => {
    // Hand-build: metadata-bearing APP1 header placed after the SOS marker.
    const parts: number[] = [0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x00, 0x01] // SOI + SOS
    const payload = new Uint8Array([...ascii('Exif\0\0'), ...ascii('MM\x00*')])
    parts.push(0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff)
    for (const b of payload) parts.push(b)
    expect(scanMetadataSignals(new Uint8Array(parts))!.signals).toEqual([])
  })

  it('finds EXIF, C2PA and XMP in PNG chunks', () => {
    const png = pngWithChunks([
      { type: 'eXIf', data: ascii('MM\x00*\x00\x00\x00\x08') },
      { type: 'caBX', data: ascii('c2pa manifest jumbf') },
      { type: 'iTXt', data: new Uint8Array([...ascii('xml:com.adobe.xmp\0\0\0\0\0'), ...ascii('<x/>)')]) },
      { type: 'tEXt', data: new Uint8Array([...ascii('Comment\0'), ...ascii('plain note')]) },
    ])
    expect(scanMetadataSignals(png)!.signals).toEqual([
      { kind: 'EXIF', location: 'png:eXIf', bytes: 8 },
      { kind: 'C2PA', location: 'png:caBX', bytes: 19 },
      { kind: 'XMP', location: 'png:iTXt', bytes: 27 },
    ])
  })

  it('finds EXIF, XMP and a C2PA JUMBF superbox in WebP chunks', () => {
    // JUMBF superbox payload: box header length(4) + type 'jumb'(4) + contents.
    const jumbfPayload = new Uint8Array([...ascii('\x00\x00\x00\x10jumb'), ...ascii('jbox')])
    const webp = webpWithChunks([
      { type: 'VP8X', data: new Uint8Array(10) },
      { type: 'EXIF', data: ascii('MM\x00*') },
      { type: 'XMP ', data: ascii('<x:xmpmeta/>') },
      { type: 'JUMB', data: jumbfPayload },
    ])
    expect(scanMetadataSignals(webp)!.signals).toEqual([
      { kind: 'EXIF', location: 'webp:EXIF', bytes: 4 },
      { kind: 'XMP', location: 'webp:XMP', bytes: 12 },
      { kind: 'C2PA', location: 'webp:JUMB(JUMBF)', bytes: 12 },
    ])
  })

  it('returns [] for a metadata-free container and null for non-images', () => {
    expect(scanMetadataSignals(pngWithChunks([{ type: 'IDAT', data: ascii('pixels') }]))!.signals).toEqual([])
    expect(scanMetadataSignals(jpegWithSegments([]))!.signals).toEqual([])
    expect(scanMetadataSignals(ascii('plain text, not an image'))).toBeNull()
    expect(scanMetadataSignals(new Uint8Array(0))).toBeNull()
  })

  it('survives truncated containers without throwing', () => {
    const png = pngWithChunks([{ type: 'caBX', data: ascii('manifest') }])
    expect(scanMetadataSignals(png.subarray(0, 14))!.signals).toEqual([]) // header only
    const webp = webpWithChunks([{ type: 'EXIF', data: ascii('MM\x00*') }])
    expect(scanMetadataSignals(webp.subarray(0, 18))!.signals).toEqual([]) // chunk header cut off
    const jpeg = jpegWithSegments([{ marker: 0xe1, payload: new Uint8Array([...ascii('Exif\0\0'), ...ascii('tiff')]) }])
    expect(scanMetadataSignals(jpeg.subarray(0, 12))!.signals).toEqual([])
  })

  it('extracts SynthID and trainedAlgorithmicMedia assertions from a PNG caBX payload', () => {
    // A caBX chunk whose data embeds CBOR text strings, as a real C2PA
    // manifest would: header 0x78 = major type 3, length 0x38 (56).
    const cbor = (text: string): Uint8Array => {
      const bytes = [...ascii(text)]
      return new Uint8Array([0x78, text.length, ...bytes])
    }
    const assertion1 = 'Applied imperceptible SynthID watermark'
    const assertion2 = 'trainedAlgorithmicMedia'
    const noise = new Uint8Array([0x12, 0x34, 0x56, 0x78]) // binary between CBOR items
    const png = pngWithChunks([
      { type: 'caBX', data: new Uint8Array([...noise, ...cbor(assertion1), ...noise, ...cbor(assertion2)]) },
    ])
    const scan = scanMetadataSignals(png)
    expect(scan).not.toBeNull()
    expect(scan!.signals).toEqual([{ kind: 'C2PA', location: 'png:caBX', bytes: 4 + 2 + assertion1.length + 4 + 2 + assertion2.length }])
    expect(scan!.selfDeclared).toEqual([
      { statement: assertion1, location: 'png:caBX' },
      { statement: assertion2, location: 'png:caBX' },
    ])
  })

  it('extracts assertions from multi-segment JPEG APP11 payloads', () => {
    const assertion = 'Created by Google Generative AI'
    // Split the CBOR text string across two APP11 segments: the header in the
    // first, the string body in the second. Continuation segments start with
    // the 4-byte JUMBF 8BIM-resource prefix 0x00 'J' 'P' (or a bare 'JP' on
    // the first segment).
    const header = new Uint8Array([0x78, assertion.length])
    const body = ascii(assertion)
    const jpeg = jpegWithSegments([
      { marker: 0xeb, payload: new Uint8Array([...ascii('JP'), ...ascii('jumb'), ...header]) },
      { marker: 0xeb, payload: new Uint8Array([0x00, ...ascii('JP'), ...body]) },
    ])
    const scan = scanMetadataSignals(jpeg)
    expect(scan).not.toBeNull()
    expect(scan!.signals.length).toBe(2)
    expect(scan!.selfDeclared).toEqual([{ statement: assertion, location: 'jpeg:APP11' }])
  })

  it('extracts assertions from a WebP JUMB superbox', () => {
    const assertion = 'Created by OpenAI'
    const jumbfPayload = new Uint8Array([...ascii('\x00\x00\x00\x10jumb'), ...new Uint8Array([0x78, assertion.length]), ...ascii(assertion)])
    const webp = webpWithChunks([{ type: 'JUMB', data: jumbfPayload }])
    const scan = scanMetadataSignals(webp)
    expect(scan).not.toBeNull()
    expect(scan!.selfDeclared).toEqual([{ statement: assertion, location: 'webp:JUMB(JUMBF)' }])
  })

  it('returns no selfDeclared when C2PA payloads contain no known assertions', () => {
    const png = pngWithChunks([{ type: 'caBX', data: ascii('manifest without assertion strings, all plain ascii') }])
    const scan = scanMetadataSignals(png)
    expect(scan).not.toBeNull()
    expect(scan!.signals.length).toBe(1)
    expect(scan!.selfDeclared).toEqual([])
  })

  it('does not match assertions shorter than 8 bytes or truncated strings', () => {
    const png = pngWithChunks([{ type: 'caBX', data: new Uint8Array([0x63, 0x61, 0x62, 0x63, 0x64, 0x65]) }]) // 'abcde', length 3 < 8
    const scan = scanMetadataSignals(png)
    expect(scan).not.toBeNull()
    expect(scan!.selfDeclared).toEqual([])
  })
})
