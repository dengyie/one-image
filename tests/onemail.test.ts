import { describe, expect, it } from 'vitest'
import { createOneMailMailer } from '../server/onemail'

function fakeFetchCapture() {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  return { calls, impl }
}

describe('OneMail mailer contract', () => {
  it('posts the send_mail envelope with token, recipient and HTML body', async () => {
    const { calls, impl } = fakeFetchCapture()
    const mailer = createOneMailMailer({
      apiBase: 'https://mail-api.example.com',
      token: 'jwt-token',
      fromName: 'OneImage',
      fetchImpl: impl,
    })
    await mailer.sendVerificationCode('user@example.com', '012345')
    expect(calls).toHaveLength(1)
    const { url, init } = calls[0]
    expect(url).toBe('https://mail-api.example.com/external/api/send_mail')
    expect(init.method).toBe('POST')
    const body = JSON.parse(String(init.body))
    expect(body.token).toBe('jwt-token')
    expect(body.to_mail).toBe('user@example.com')
    expect(body.from_name).toBe('OneImage')
    expect(body.is_html).toBe(true)
    expect(body.subject).toContain('012345')
    // The code is in the HTML body (the user copies it from the mail).
    expect(body.content).toContain('012345')
    // The token must ride the body envelope (the one-mail API reads it from
    // JSON), never a header — keep the contract pinned either way.
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
  })

  it('maps a non-2xx reply to a thrown error carrying the status', async () => {
    const impl = (async () => new Response('quota exceeded', { status: 429 })) as typeof fetch
    const mailer = createOneMailMailer({
      apiBase: 'https://mail-api.example.com',
      token: 't',
      fromName: 'OneImage',
      fetchImpl: impl,
    })
    await expect(mailer.sendVerificationCode('user@example.com', '654321')).rejects.toThrow(/429.*quota exceeded/s)
  })

  it('propagates transport failures (timeout/abort) to the caller', async () => {
    const impl = (async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError')
    }) as unknown as typeof fetch
    const mailer = createOneMailMailer({
      apiBase: 'https://mail-api.example.com',
      token: 't',
      fromName: 'OneImage',
      fetchImpl: impl,
    })
    await expect(mailer.sendVerificationCode('user@example.com', '654321')).rejects.toThrow()
  })
})
