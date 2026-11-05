import { ProxyAgent, setGlobalDispatcher } from 'undici'

export interface OutboundProxyOptions {
  uri: string
  requestTls: { timeout: number }
  proxyTls: { timeout: number }
}

/**
 * undici gives a tunnelled request ten seconds to come up. A self-hosted egress
 * proxy that is merely slow — not down — routinely needs longer: on the
 * production host the same CONNECT to the gateway has taken anywhere between
 * one and forty-five seconds, and every generation whose tunnel started inside
 * that window died with `ConnectTimeoutError` ("timeout: 10000ms") while the
 * proxy went on to answer seconds later. These are the only tunnel timeouts
 * undici honours for a CONNECT over an http proxy — `connect.timeout` and
 * `connectTimeout` are not applied to the tunnel itself — so they are raised
 * well past the observed latency. The per-request `AbortSignal` still caps the
 * whole call, so a genuinely dead proxy cannot hold a request open longer than
 * the generation timeout.
 */
export function outboundProxyOptions(proxyUrl: string): OutboundProxyOptions {
  return {
    uri: proxyUrl,
    requestTls: { timeout: 30_000 },
    proxyTls: { timeout: 30_000 },
  }
}

export function configureOutboundProxy(proxyUrl: string | undefined): boolean {
  const normalized = proxyUrl?.trim()
  if (!normalized) return false
  setGlobalDispatcher(new ProxyAgent(outboundProxyOptions(normalized)))
  return true
}
