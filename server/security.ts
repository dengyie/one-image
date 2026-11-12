import { createHash, timingSafeEqual } from 'node:crypto'

export type RequestHeaders = Record<string, string | string[] | undefined>

export function authorizeProvenanceRequest(headers: RequestHeaders, serverToken: string, allowDevelopmentOrigin: boolean): boolean {
  const suppliedToken = headers['x-oneimage-token']
  if (serverToken.length > 0) {
    // Hash both sides before timingSafeEqual: the digest is fixed-length, so
    // the comparison neither leaks the token length nor short-circuits on the
    // first differing byte.
    if (typeof suppliedToken !== 'string') return false
    const provided = createHash('sha256').update(suppliedToken).digest()
    const expected = createHash('sha256').update(serverToken).digest()
    return timingSafeEqual(provided, expected)
  }
  if (!allowDevelopmentOrigin) return false

  const origin = headers.origin
  const host = headers.host
  if (typeof origin !== 'string' || typeof host !== 'string') return false
  const forwardedProto = headers['x-forwarded-proto']
  const protocol = typeof forwardedProto === 'string' && forwardedProto === 'https' ? 'https' : 'http'
  return origin === `${protocol}://${host}`
}
