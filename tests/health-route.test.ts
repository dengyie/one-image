import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerHealthRoute } from '../server/health-route'

describe('health route', () => {
  it('returns healthy without exposing provider secrets when configured', async () => {
    const app = Fastify()
    registerHealthRoute(app, { providerConfigured: true })
    const response = await app.inject({ method: 'GET', url: '/healthz' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok', providerConfigured: true })
    await app.close()
  })

  it('returns degraded when no provider is configured', async () => {
    const app = Fastify()
    registerHealthRoute(app, { providerConfigured: false })
    const response = await app.inject({ method: 'GET', url: '/healthz' })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ status: 'degraded', providerConfigured: false })
    await app.close()
  })
})

describe('health route inpaint warm enrichment', () => {
  it('reports live inpaint warm states when wired', async () => {
    const app = Fastify()
    registerHealthRoute(app, {
      providerConfigured: true,
      inpaintWarm: { lama: false, migan: true },
    })
    const response = await app.inject({ method: 'GET', url: '/healthz' })
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toEqual({
      status: 'ok',
      providerConfigured: true,
      inpaintWarm: { lama: false, migan: true },
    })
  })

  it('omits the inpaint section when not wired (deploy-safe for the receiver probe)', async () => {
    const app = Fastify()
    registerHealthRoute(app, { providerConfigured: true })
    const response = await app.inject({ method: 'GET', url: '/healthz' })
    const body = JSON.parse(response.body)
    expect(body.inpaintWarm).toBeUndefined()
    expect(body.status).toBe('ok')
  })
})
