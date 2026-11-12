import type { FastifyInstance } from 'fastify'

export interface HealthState {
  providerConfigured: boolean
  /** Live inpaint warm states — ops sees exactly which tiers can serve. */
  inpaintWarm?: { lama: boolean; migan: boolean }
}

export function registerHealthRoute(app: FastifyInstance, state: HealthState): void {
  app.get('/healthz', async (_request, reply) => {
    const healthy = state.providerConfigured
    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      providerConfigured: healthy,
      ...(state.inpaintWarm ? { inpaintWarm: state.inpaintWarm } : {}),
    })
  })
}
