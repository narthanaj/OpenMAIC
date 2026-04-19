import type { FastifyInstance } from 'fastify';
import { registry, updateQueueGauges } from '../metrics.js';
import type { JobStore } from '../jobs/store.js';

// Prometheus text-format scrape endpoint. Auth-gated via the global preHandler —
// metric labels may carry sensitive info (classroom ids, failure messages) and
// there's no good reason to expose them publicly.
//
// The queue-depth gauges are refreshed on every scrape rather than on every job
// event. Prometheus scrapes ~every 15s; the alternative (updating gauges in
// every store.update() call) would be noisier without benefiting any real query.

export interface MetricsRouteDeps {
  store: JobStore;
}

export async function registerMetricsRoute(
  app: FastifyInstance,
  deps: MetricsRouteDeps,
): Promise<void> {
  app.get('/metrics', async (_req, reply) => {
    await updateQueueGauges((s) => deps.store.countByStatus(s));
    const body = await registry.metrics();
    reply.header('content-type', registry.contentType).send(body);
  });
}
