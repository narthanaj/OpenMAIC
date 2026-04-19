import type { Readable } from 'node:stream';
import type { FastifyBaseLogger } from 'fastify';
import type { Job } from './types.js';
import type { FailureReason } from './types.js';
import type { JobStore } from './store.js';
import type { ExportStorage } from '../storage/types.js';
import type { ContentExporter } from '../exporters/types.js';
import type { OpenMaicClient } from '../sources/openmaic.js';
import { postWebhook } from './webhook.js';
import type { Classroom } from '../validation/classroom.js';
import {
  ClassroomNotFoundError,
  UpstreamError,
  FetchTimeoutError,
  FetchValidationError,
} from '../sources/openmaic.js';
import * as metrics from '../metrics.js';

// In-process worker pool (pull-mode only).
//
// Processes jobs one-at-a-time per worker, up to `concurrency` workers in parallel.
// Each worker loops until `stopping` flips true, returns after finishing its current
// job. Jobs queued during shutdown stay in status='pending' and are picked up by
// whoever boots next (or get TTL-swept if the service stays down long enough).
//
// There is NO inline-classroom path anymore — that went away when the UI moved
// to local-first browser-side zipping. Every job carries a classroomId that the
// worker fetches from OpenMAIC over the internal Docker network.

export interface WorkerDeps {
  store: JobStore;
  storage: ExportStorage;
  openmaic: OpenMaicClient;
  exporters: Record<string, ContentExporter>;
  logger: FastifyBaseLogger;
  baseUrl: string; // used to build downloadUrl for webhook payloads
}

export interface WorkerPool {
  start(): void;
  enqueue(jobId: string): void;
  drain(timeoutMs: number): Promise<boolean>;
  abandonRunning(reason: string): Promise<void>;
  inFlight(): number;
}

export function createWorkerPool(concurrency: number, deps: WorkerDeps): WorkerPool {
  const queue: string[] = [];
  let stopping = false;
  let waiters: Array<() => void> = [];
  const runningSet = new Set<string>();
  const workerPromises: Promise<void>[] = [];

  function wakeOneWaiter(): void {
    const w = waiters.shift();
    if (w) w();
  }

  function wakeAllWaiters(): void {
    const toWake = waiters;
    waiters = [];
    for (const w of toWake) w();
  }

  function nextJob(): Promise<string | null> {
    return new Promise((resolve) => {
      const tryDeliver = () => {
        if (queue.length > 0) {
          resolve(queue.shift()!);
          return true;
        }
        if (stopping) {
          resolve(null);
          return true;
        }
        return false;
      };
      if (tryDeliver()) return;
      waiters.push(() => {
        if (!tryDeliver()) waiters.push(() => resolve(null));
      });
    });
  }

  async function handleOne(jobId: string): Promise<void> {
    runningSet.add(jobId);
    metrics.jobsRunning.set(runningSet.size);
    deps.logger.info({ jobId }, 'job started');

    const job = await deps.store.get(jobId);
    if (!job) {
      deps.logger.warn({ jobId }, 'job vanished before worker could process it');
      runningSet.delete(jobId);
      metrics.jobsRunning.set(runningSet.size);
      return;
    }

    const startNs = process.hrtime.bigint();
    const endTimer = () => Number(process.hrtime.bigint() - startNs) / 1e9;

    try {
      await deps.store.update(jobId, { status: 'running' });

      // Pull-only: every job must have a classroomId. The schema guarantees this
      // at the HTTP boundary; this check defends against store corruption / manual
      // rows that somehow lack the field.
      if (!job.classroomId) {
        throw new Error('pull-mode job missing classroomId');
      }
      const classroom: Classroom = await deps.openmaic.fetchClassroomById(job.classroomId);

      const exporter = deps.exporters[job.format];
      if (!exporter) throw new Error(`unknown format: ${job.format}`);

      let zipStream: Readable;
      try {
        zipStream = await exporter.export(classroom);
      } catch (err) {
        throw Object.assign(err as Error, { __reason: 'render' as FailureReason });
      }

      const resultKey = `${job.format}/${job.id}.zip`;
      try {
        await deps.storage.put(resultKey, zipStream);
      } catch (err) {
        throw Object.assign(err as Error, { __reason: 'storage' as FailureReason });
      }

      await deps.store.update(jobId, { status: 'done', resultKey });
      metrics.jobsCompleted.inc({ format: job.format });
      metrics.exportDuration.observe({ format: job.format }, endTimer());
      deps.logger.info({ jobId, resultKey }, 'job done');

      if (job.webhookUrl) {
        const downloadUrl = `${deps.baseUrl}/export/jobs/${jobId}/download`;
        const result = await postWebhook(job.webhookUrl, { jobId, status: 'done', downloadUrl });
        metrics.webhookAttempts.inc({ result: result.ok ? 'success' : 'failed' });
        if (!result.ok) {
          deps.logger.warn(
            { jobId, webhookUrl: job.webhookUrl, attempts: result.attempts, lastStatus: result.lastStatus, lastError: result.lastError },
            'webhook delivery failed (job stays done)',
          );
        }
      }
    } catch (err: unknown) {
      const reason = reasonFor(err);
      const message = err instanceof Error ? err.message : String(err);
      await deps.store.update(jobId, { status: 'failed', error: message });
      metrics.jobsFailed.inc({ format: job.format, reason });
      metrics.exportDuration.observe({ format: job.format }, endTimer());
      deps.logger.error({ jobId, reason, err: message }, 'job failed');

      if (job.webhookUrl) {
        const result = await postWebhook(job.webhookUrl, { jobId, status: 'failed', error: message });
        metrics.webhookAttempts.inc({ result: result.ok ? 'success' : 'failed' });
      }
    } finally {
      runningSet.delete(jobId);
      metrics.jobsRunning.set(runningSet.size);
    }
  }

  async function workerLoop(workerId: number): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const jobId = await nextJob();
      if (jobId == null) return;
      try {
        await handleOne(jobId);
      } catch (err) {
        deps.logger.error({ workerId, err }, 'unhandled worker error (continuing)');
      }
    }
  }

  return {
    start(): void {
      for (let i = 0; i < concurrency; i++) {
        workerPromises.push(workerLoop(i));
      }
      deps.logger.info({ concurrency }, 'worker pool started');
    },

    enqueue(jobId): void {
      if (stopping) {
        deps.logger.warn({ jobId }, 'enqueue after shutdown started — ignored');
        return;
      }
      queue.push(jobId);
      wakeOneWaiter();
    },

    async drain(timeoutMs): Promise<boolean> {
      stopping = true;
      wakeAllWaiters();
      const deadline = Date.now() + timeoutMs;
      while (runningSet.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      return runningSet.size === 0;
    },

    async abandonRunning(reason): Promise<void> {
      const running = await deps.store.listByStatus('running');
      for (const job of running) {
        await deps.store
          .update(job.id, { status: 'failed', error: `abandoned: ${reason}` })
          .catch(() => {});
        metrics.jobsAbandoned.inc();
        metrics.jobsFailed.inc({ format: job.format, reason: 'shutdown' });
      }
      if (running.length > 0) {
        deps.logger.warn({ count: running.length, reason }, 'abandoned still-running jobs on shutdown');
      }
    },

    inFlight(): number {
      return runningSet.size;
    },
  };
}

function reasonFor(err: unknown): FailureReason {
  if (err instanceof ClassroomNotFoundError) return 'fetch_404';
  if (err instanceof UpstreamError) return 'fetch_upstream';
  if (err instanceof FetchTimeoutError) return 'timeout';
  if (err instanceof FetchValidationError) return 'validation';
  const tagged = (err as { __reason?: FailureReason })?.__reason;
  if (tagged) return tagged;
  return 'other';
}
