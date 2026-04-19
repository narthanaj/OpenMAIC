import type { FastifyInstance } from 'fastify';
import { listExporters } from '../exporters/registry.js';

// GET /formats — enumerates available export formats.
//
// Used by the UI to populate dropdowns so clients don't have to hardcode format
// ids. Auth-gated like the rest of /api (nginx stamps the bearer token in the
// proxy layer). Returns {formats:[{id, name}]}.

export async function registerFormatsRoute(app: FastifyInstance): Promise<void> {
  app.get('/formats', async () => ({
    formats: listExporters().map((e) => ({ id: e.id, name: e.name })),
  }));
}
