import { describe, expect, it } from 'vitest'
import { assertSafeImageUrl, ImagegenUpstreamError, isPrivateHost } from '../server/imagegen-providers'
import type { ImagegenProviderConfig } from '../server/imagegen-config'

// The download URL arrives from the upstream body, so these helpers are the
// SSRF line of defense: https-only off-host, and no loopback/private targets.
// WHATWG URL normalizes IPv4-mapped v6 to hex ("[::ffff:127.0.0.1]" ->
// "[::ffff:7f00:1]"), hence the hex-shaped mapped cases below.
const provider: ImagegenProviderConfig = { baseUrl: 'https://gw.example.com/v1' } as ImagegenProviderConfig

describe('isPrivateHost', () => {
  it.each([
    // loopback / this-host / link-local / RFC1918 / ULA / multicast+
    ['localhost', true],
    ['foo.localhost', true],
    ['api.internal', true],
    // k8s cluster names + mDNS + dot-less single-label hosts
    ['download.svc', true],
    ['files.svc.cluster.local', true],
    ['printer.local', true],
    ['intranet', true],
    ['LOCALHOST', true],
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['0.0.0.0', true],
    ['169.254.169.254', true],
    ['192.168.1.1', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['::', true],
    ['::1', true],
    ['fe80::1', true],
    ['fc00::1', true],
    ['fd12:3456::a', true],
    ['::ffff:127.0.0.1', true],
    // the hex form URL normalization produces for [::ffff:127.0.0.1]
    ['::ffff:7f00:1', true],
    // URL hostname for bracketed v6 keeps the brackets
    ['[::1]', true],
    ['[::ffff:7f00:1]', true],
    // public addresses must pass — a false positive here breaks every
    // legitimate upstream download URL
    ['8.8.8.8', false],
    ['172.32.0.1', false],
    ['11.0.0.1', false],
    ['100.64.0.1', false],
    ['203.0.113.10', false],
    ['gw.example.com', false],
    ['gw.example.com.', false],
    // 172.15/172.32 straddle the RFC1918 boundary
    ['172.15.255.255', false],
    ['[2001:db8::1]', false],
    ['2001:db8::5', false],
  ])('%s -> %s', (host, expected) => {
    expect(isPrivateHost(host)).toBe(expected)
  })
})

describe('assertSafeImageUrl', () => {
  const kind = '图片'

  it('accepts https public URLs and returns the parsed URL', () => {
    const url = assertSafeImageUrl('https://cdn.example.com/img.png?sig=1', provider, kind)
    expect(url.host).toBe('cdn.example.com')
  })

  it('accepts plain http only when it matches the provider baseUrl host', () => {
    const url = assertSafeImageUrl('http://gw.example.com/v1/files/img.png', provider, kind)
    expect(url.protocol).toBe('http:')
  })

  it('rejects http on any other host', () => {
    expect(() => assertSafeImageUrl('http://cdn.example.com/img.png', provider, kind)).toThrow(ImagegenUpstreamError)
  })

  it('rejects unparseable URLs as a 502 upstream error', () => {
    try {
      assertSafeImageUrl('not a url', provider, kind)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ImagegenUpstreamError)
      expect((err as ImagegenUpstreamError).status).toBe(502)
      expect((err as Error).message).toContain('无法解析')
    }
  })

  it.each([
    'https://127.0.0.1/img.png',
    'https://[::1]/img.png',
    // mapped-v4 hidden in the hex form URL normalization emits
    'https://[::ffff:7f00:1]/img.png',
    'https://169.254.169.254/latest/meta-data',
    'https://internal.svc/img.png',
  ])('rejects private/loopback targets: %s', (rawUrl) => {
    try {
      assertSafeImageUrl(rawUrl, provider, kind)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ImagegenUpstreamError)
      expect((err as ImagegenUpstreamError).status).toBe(502)
      expect((err as Error).message).toContain('内网/回环')
    }
  })

  it('carries the video kind through in rejection messages', () => {
    expect(() => assertSafeImageUrl('https://localhost/v.mp4', provider, '视频')).toThrow(/视频/)
  })

  it('splits scheme check from host check: private https target is rejected even off-host', () => {
    // https alone is not enough — the host must also be public
    expect(() => assertSafeImageUrl('https://10.0.0.5/img.png', provider, kind)).toThrow(/内网/)
  })
})
