import type { FastifyBaseLogger } from 'fastify';
import type { JobStore } from './store.js';
import type { ExportStorage } from '../storage/types.js';
import * as metrics from '../metrics.js';

// Hourly TTL sweep: delete job records and their stored ZIPs once they're older
// than `ttlMs`. Runs on a simple setInterval — no cross-node coordination (the day-1
// architecture is single-instance; see the "scaling conflict" section of the plan
// for how this generalizes later).

export interface Cleanup {
  start(): void;
  stop(): void;
  // Exposed for tests and for the startup warmup (run once immediately so the
  // gauge isn't empty for the first hour).
  sweepOnce(): Promise<void>;
}

export interface CleanupOptions {
  store: JobStore;
  storage: ExportStorage;
  ttlMs: number;
  intervalMs: number;
  logger: FastifyBaseLogger;
}

export function createCleanup(opts: CleanupOptions): Cleanup {
  let timer: NodeJS.Timeout | null = null;

  async function sweepOnce(): Promise<void> {
    const cutoff = Date.now() - opts.ttlMs;
    const expired = await opts.store.listExpired(cutoff);
    let deleted = 0;
    for (const job of expired) {
      try {
        if (job.resultKey) {
          await opts.storage.delete(job.resultKey).catch((err) => {
            opts.logger.warn({ jobId: job.id, err }, 'failed to delete expired ZIP (continuing)');
          });
        }
        await opts.store.delete(job.id);
        deleted++;
      } catch (err) {
        opts.logger.warn({ jobId: job.id, err }, 'cleanup error for job (continuing)');
      }
    }
    if (deleted > 0) {
      metrics.jobsCleaned.inc(deleted);
      opts.logger.info({ deleted, cutoff }, 'TTL sweep evicted expired jobs');
    }

    // Update the storage gauge opportunistically each sweep so Grafana sees fresh
    // numbers without a separate scheduler.
    if (opts.storage.sizeBytes) {
      const bytes = await opts.storage.sizeBytes().catch(() => 0);
      metrics.storageBytes.set(bytes);
    }
  }

  return {
    start(): void {
      // Fire once immediately so the gauge is populated and any dangling records
      // from a crash-recovered boot are evicted promptly.
      void sweepOnce();
      timer = setInterval(() => void sweepOnce(), opts.intervalMs);
      // Don't hold the event loop open solely for the sweep.
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    sweepOnce,
  };
}
