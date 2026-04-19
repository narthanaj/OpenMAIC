import type { FastifyInstance } from 'fastify';

// Plain-JSON health endpoint. Skipped by the auth preHandler (see auth.ts default
// unauthenticated list) so the docker healthcheck can hit it without the token.
// The response shape is deliberately minimal — anything dynamic in here just adds
// surface area for tricky failures during a platform-level probe.

export async function registerHealthRoute(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({
    status: 'ok',
    service: 'openmaic-exporter',
    version: '0.1.0',
  }));
}
