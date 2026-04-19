import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ExportRequestSchema } from '../validation/requests.js';
import type { JobStore } from '../jobs/store.js';
import type { WorkerPool } from '../jobs/worker.js';
import { newJob } from '../jobs/types.js';
import { knownFormats } from '../exporters/registry.js';
import * as metrics from '../metrics.js';

// POST /export/:format
//
// Pull-mode only: body is { classroomId, webhookUrl? }. Push mode was removed
// when the UI went local-first; push bodies now return 400 at the schema boundary.
//
// Validates the body via zod, registers a Job row in the store, and enqueues it
// on the worker pool. Returns 202 with the assigned jobId — the actual export
// (OpenMAIC fetch + zip + storage write) happens asynchronously.
//
// Validation errors return a structured 400 with per-issue path + message so callers
// can programmatically pinpoint bad fields rather than grepping an error string.

export interface ExportRouteDeps {
  store: JobStore;
  workers: WorkerPool;
}

export async function registerExportRoute(
  app: FastifyInstance,
  deps: ExportRouteDeps,
): Promise<void> {
  app.post('/export/:format', async (req: FastifyRequest, reply: FastifyReply) => {
    const { format } = req.params as { format?: string };
    if (!format || !knownFormats().includes(format)) {
      return reply.code(404).send({
        error: 'unknown_format',
        message: `format "${format}" not supported`,
        supported: knownFormats(),
      });
    }

    const parsed = ExportRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      metrics.validationErrors.inc({ route: 'export' });
      return reply.code(400).send({
        error: 'validation_failed',
        issues: parsed.error.issues.map((i) => ({
          path: i.path,
          message: i.message,
        })),
      });
    }

    const { classroomId, webhookUrl } = parsed.data;

    const job = newJob(format, classroomId, webhookUrl ?? null);
    await deps.store.create(job);
    deps.workers.enqueue(job.id);

    req.log.info(
      { jobId: job.id, format, classroomId, webhookUrl: webhookUrl ?? null },
      'export job created',
    );

    return reply.code(202).send({ jobId: job.id, status: job.status, format });
  });
}
