import type { FastifyInstance } from 'fastify'

export interface PublicCapabilities {
  provenance: {
    enabled: boolean
    provider: string | null
    maxInputBytes: number
  }
  // Server-side smart-erase (LaMa): the browser hides the 高质量 tier unless
  // the host has the model deployed. Absent keys stay deploy-safe for the
  // receiver's grep probe.
  smartErase?: {
    lamaAvailable: boolean
    /** MI-GAN server tier (标准 model executed on the host): live warm gate. */
    miganServerAvailable: boolean
  }
}

export function registerCapabilitiesRoute(app: FastifyInstance, capabilities: PublicCapabilities): void {
  app.get('/api/v1/capabilities', async (_request, reply) => reply.code(200).send(capabilities))
}
