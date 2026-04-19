import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { JobIdParamSchema } from '../validation/requests.js';
import type { JobStore } from '../jobs/store.js';
import type { ExportStorage } from '../storage/types.js';
import type { Job } from '../jobs/types.js';
import * as metrics from '../metrics.js';

// GET /export/jobs/:id               → status JSON
// GET /export/jobs/:id/download      → streaming ZIP
//
// The download route distinguishes four states:
//   - job unknown                         → 404
//   - job known but status != 'done'      → 409 (try again later)
//   - job done but result missing in storage → 410 (expired — TTL swept it)
//   - job done and result present         → 200 application/zip (streamed)

export interface JobsRouteDeps {
  store: JobStore;
  storage: ExportStorage;
}

function projectJob(job: Job) {
  return {
    id: job.id,
    status: job.status,
    format: job.format,
    classroomId: job.classroomId,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    // Intentionally NOT exposed: webhookUrl, resultKey. Those are internal bookkeeping
    // callers don't need; webhookUrl in particular could leak if the ID is shared.
  };
}

export async function registerJobsRoutes(
  app: FastifyInstance,
  deps: JobsRouteDeps,
): Promise<void> {
  // GET /export/jobs?limit=N → recent jobs (newest first). Drives the UI's "Recent
  // jobs" table. Pagination is a simple top-N cap; no cursor for v1.
  app.get('/export/jobs', async (req: FastifyRequest, reply: FastifyReply) => {
    const raw = (req.query as { limit?: string } | undefined)?.limit;
    const parsed = raw == null ? 50 : Number(raw);
    const limit = Number.isFinite(parsed) && parsed > 0 && parsed <= 200 ? Math.floor(parsed) : 50;
    const jobs = await deps.store.listRecent(limit);
    return reply.send({ jobs: jobs.map(projectJob) });
  });

  app.get('/export/jobs/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const params = JobIdParamSchema.safeParse(req.params);
    if (!params.success) {
      metrics.validationErrors.inc({ route: 'jobs_status' });
      return reply.code(400).send({
        error: 'validation_failed',
        issues: params.error.issues.map((i) => ({ path: i.path, message: i.message })),
      });
    }
    const job = await deps.store.get(params.data.id);
    if (!job) return reply.code(404).send({ error: 'job_not_found' });
    return reply.send(projectJob(job));
  });

  app.get('/export/jobs/:id/download', async (req: FastifyRequest, reply: FastifyReply) => {
    const params = JobIdParamSchema.safeParse(req.params);
    if (!params.success) {
      metrics.validationErrors.inc({ route: 'jobs_download' });
      return reply.code(400).send({
        error: 'validation_failed',
        issues: params.error.issues.map((i) => ({ path: i.path, message: i.message })),
      });
    }
    const job = await deps.store.get(params.data.id);
    if (!job) return reply.code(404).send({ error: 'job_not_found' });

    if (job.status !== 'done') {
      return reply.code(409).send({
        error: 'not_done',
        status: job.status,
        detail:
          job.status === 'failed'
            ? `job failed: ${job.error ?? 'unknown error'}`
            : 'export still in progress — poll /export/jobs/:id or wait for webhook',
      });
    }
    if (!job.resultKey) {
      return reply.code(410).send({ error: 'expired_or_missing', detail: 'result not present in storage' });
    }
    if (!(await deps.storage.exists(job.resultKey))) {
      return reply.code(410).send({ error: 'expired_or_missing', detail: 'TTL sweep removed the ZIP' });
    }

    const stream = await deps.storage.get(job.resultKey);
    const filename = `classroom-${job.id}.zip`;
    reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${filename}"`);
    return reply.send(stream);
  });
}
