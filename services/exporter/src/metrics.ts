import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';

// Dedicated registry rather than the global `prom-client` default — keeps the
// exporter's metrics neatly namespaced and lets tests stand up isolated instances
// without cross-contaminating state between test cases.

export const registry = new Registry();

// Default process metrics: CPU, RSS, event-loop lag, GC pauses, heap size.
// `prom-client` namespaces these with its own `nodejs_*` / `process_*` prefixes,
// so setting our own prefix here isn't needed.
collectDefaultMetrics({ register: registry });

export const jobsPending = new Gauge({
  name: 'exporter_jobs_pending',
  help: 'Number of export jobs waiting to be picked up by a worker.',
  registers: [registry],
});

export const jobsRunning = new Gauge({
  name: 'exporter_jobs_running',
  help: 'Number of export jobs currently being processed.',
  registers: [registry],
});

export const jobsCompleted = new Counter({
  name: 'exporter_jobs_completed_total',
  help: 'Count of export jobs that finished successfully, by format.',
  labelNames: ['format'] as const,
  registers: [registry],
});

export const jobsFailed = new Counter({
  name: 'exporter_jobs_failed_total',
  help: 'Count of export jobs that failed, by format and failure reason class.',
  labelNames: ['format', 'reason'] as const,
  registers: [registry],
});

export const jobsAbandoned = new Counter({
  name: 'exporter_jobs_abandoned_total',
  help: 'Count of jobs force-failed because the service shut down mid-flight.',
  registers: [registry],
});

export const jobsCleaned = new Counter({
  name: 'exporter_jobs_cleaned_total',
  help: 'Count of job records (and their ZIPs) evicted by the TTL sweep.',
  registers: [registry],
});

export const exportDuration = new Histogram({
  name: 'exporter_export_duration_seconds',
  help: 'Wall-clock time to produce an export package, by format.',
  labelNames: ['format'] as const,
  // Buckets tuned for the expected range: a small classroom packages in ~1s, a
  // 50-slide one in ~10s, outliers up to a minute. Beyond that is a bug worth paging.
  buckets: [0.1, 0.5, 1, 2, 5, 10, 20, 45, 90],
  registers: [registry],
});

export const webhookAttempts = new Counter({
  name: 'exporter_webhook_attempts_total',
  help: 'Count of webhook delivery attempts, by terminal result.',
  labelNames: ['result'] as const, // 'success' | 'failed'
  registers: [registry],
});

export const validationErrors = new Counter({
  name: 'exporter_validation_errors_total',
  help: 'Count of requests rejected by zod validation, by route.',
  labelNames: ['route'] as const,
  registers: [registry],
});

export const storageBytes = new Gauge({
  name: 'exporter_storage_bytes',
  help: 'Current on-disk footprint of the export storage backend (bytes).',
  registers: [registry],
});

// Convenience for feeding the pending/running gauges from the JobStore.
export async function updateQueueGauges(
  countByStatus: (s: 'pending' | 'running') => Promise<number>,
): Promise<void> {
  const [p, r] = await Promise.all([countByStatus('pending'), countByStatus('running')]);
  jobsPending.set(p);
  jobsRunning.set(r);
}
