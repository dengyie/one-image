import { describe, expect, it } from 'vitest'
import { sniffVideoMime } from '../server/imagegen-providers'

// The container magic wins over a declared Content-Type: aggregators mislabel
// payloads (e.g. video/quicktime on an mp4), and the browser needs a mime it
// can actually play. Bytes are the ground truth.
const mp4 = Buffer.from([0x00, 0x00, 0x00, 0x18, ...Buffer.from('ftypisom'), 0x00])
const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04])

describe('sniffVideoMime', () => {
  it('detects mp4 by the ftyp box even when the header lies', () => {
    expect(sniffVideoMime(mp4, 'video/quicktime')).toBe('video/mp4')
    expect(sniffVideoMime(mp4, null)).toBe('video/mp4')
  })

  it('detects webm by the EBML magic even when the header lies', () => {
    expect(sniffVideoMime(webm, 'application/octet-stream')).toBe('video/webm')
    expect(sniffVideoMime(webm, 'video/mp4')).toBe('video/webm')
  })

  it('falls back to a video/* Content-Type when bytes are unrecognized', () => {
    const unknown = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(sniffVideoMime(unknown, 'video/webm; codecs="vp9"')).toBe('video/webm')
    expect(sniffVideoMime(unknown, ' video/MP2T ')).toBe('video/MP2T')
    expect(sniffVideoMime(unknown, null)).toBe('video/mp4')
  })

  it('defaults to mp4 for non-video headers and short/truncated buffers', () => {
    expect(sniffVideoMime(Buffer.alloc(0), 'text/html')).toBe('video/mp4')
    // Shorter than the magic: container detection must not read out of bounds.
    expect(sniffVideoMime(Buffer.from([0x1a, 0x45]), null)).toBe('video/mp4')
    expect(sniffVideoMime(Buffer.from([0x00, 0x00, 0x00]), null)).toBe('video/mp4')
  })

  it('does not mistake an image payload for a video even if labeled one', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
    expect(sniffVideoMime(png, 'video/mp4')).toBe('video/mp4')
    expect(sniffVideoMime(png, 'image/png')).toBe('video/mp4')
  })
})
