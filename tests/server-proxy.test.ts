import { describe, expect, it, vi } from 'vitest'
import { configureOutboundProxy, outboundProxyOptions } from '../server/proxy'

const { ProxyAgent, setGlobalDispatcher } = vi.hoisted(() => ({
  ProxyAgent: vi.fn(function ProxyAgent(options: unknown) {
    return { options }
  }),
  setGlobalDispatcher: vi.fn(),
}))

vi.mock('undici', () => ({ ProxyAgent, setGlobalDispatcher }))

describe('server outbound proxy', () => {
  it('routes provider fetch through the configured HTTPS proxy', () => {
    expect(configureOutboundProxy('http://127.0.0.1:7897')).toBe(true)
    expect(ProxyAgent).toHaveBeenCalledWith(outboundProxyOptions('http://127.0.0.1:7897'))
    expect(setGlobalDispatcher).toHaveBeenCalledWith({
      options: outboundProxyOptions('http://127.0.0.1:7897'),
    })
  })

  // A slow proxy is the normal case on the production host; the stock 10s
  // tunnel budget turned that into a failed generation instead of a slow one.
  it('gives the tunnel far more than the undici default ten seconds', () => {
    const options = outboundProxyOptions('http://127.0.0.1:7897')
    expect(options.uri).toBe('http://127.0.0.1:7897')
    expect(options.requestTls.timeout).toBeGreaterThan(10_000)
    expect(options.proxyTls.timeout).toBeGreaterThan(10_000)
  })

  it('trims the configured proxy url before handing it to the agent', () => {
    ProxyAgent.mockClear()
    expect(configureOutboundProxy('  http://127.0.0.1:7897 ')).toBe(true)
    expect(ProxyAgent).toHaveBeenCalledWith(outboundProxyOptions('http://127.0.0.1:7897'))
  })

  it('does not install a dispatcher when no proxy is configured', () => {
    ProxyAgent.mockClear()
    setGlobalDispatcher.mockClear()
    expect(configureOutboundProxy(undefined)).toBe(false)
    expect(configureOutboundProxy('   ')).toBe(false)
    expect(ProxyAgent).not.toHaveBeenCalled()
    expect(setGlobalDispatcher).not.toHaveBeenCalled()
  })
})
