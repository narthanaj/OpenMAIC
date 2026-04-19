import Fastify, { type FastifyInstance } from 'fastify';
import underPressure from '@fastify/under-pressure';
import { loadConfig, dbPathFor, storageRootFor, type Config } from './config.js';
import { installAuth } from './auth.js';
import { SqliteJobStore } from './jobs/store-sqlite.js';
import { LocalDiskStorage } from './storage/local.js';
import { createOpenMaicClient } from './sources/openmaic.js';
import { createWorkerPool, type WorkerPool } from './jobs/worker.js';
import { createCleanup, type Cleanup } from './jobs/cleanup.js';
import { registerHealthRoute } from './routes/health.js';
import { registerMetricsRoute } from './routes/metrics.js';
import { registerExportRoute } from './routes/export.js';
import { registerExportFromBundleRoute } from './routes/export-from-bundle.js';
import { registerJobsRoutes } from './routes/jobs.js';
import { registerFormatsRoute } from './routes/formats.js';
import { listExporters } from './exporters/registry.js';
import type { JobStore } from './jobs/store.js';

// Service entry point. Responsibilities:
//   1. Load + validate config (fail-closed).
//   2. Wire persistence (store, storage), I/O clients (OpenMAIC source), and the
//      worker pool + cleanup sweep.
//   3. Install auth + routes on a Fastify instance with a non-default bodyLimit.
//   4. Install SIGTERM/SIGINT handlers for graceful shutdown.
//   5. Listen.

export interface BuiltServer {
  app: FastifyInstance;
  store: JobStore;
  workers: WorkerPool;
  cleanup: Cleanup;
  config: Config;
}

export function buildServer(config: Config): BuiltServer {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Redaction lives here (not in a serializer) because Pino evaluates the
      // paths on EVERY log record including the automatic 400/500 error logs
      // that include `req.body`. Without this, a rejected 100 MB /from-bundle
      // POST would dump 100 MB of base64 into stdout — crashing Loki /
      // Datadog / any downstream aggregator that buffers log lines in memory.
      // The `.*` suffixes redact each map entry individually (otherwise Pino
      // serializes the entire `_embeddedAudio` object first, then redacts the
      // string — the intermediate string is already huge).
      redact: {
        paths: [
          'req.body._embeddedAudio',
          'req.body._embeddedMedia',
          'req.body._embeddedAudio.*',
          'req.body._embeddedMedia.*',
          'body._embeddedAudio',
          'body._embeddedMedia',
          'body._embeddedAudio.*',
          'body._embeddedMedia.*',
        ],
        censor: '[redacted: embedded blob]',
      },
    },
    // Global bodyLimit stays at Fastify's default (1 MB). Pull-mode request
    // bodies are ~100 bytes; big payloads only land on the /from-bundle route
    // which sets its own `bodyLimit: 100_000_000` in its route opts.
    // routerOptions.ignoreTrailingSlash makes /export and /export/ equivalent —
    // defensive against any nginx rewrite asymmetry. Fastify 5+ nests router flags
    // under `routerOptions`; passing `ignoreTrailingSlash` top-level logs a
    // deprecation warning (removed in Fastify 6).
    routerOptions: {
      ignoreTrailingSlash: true,
    },
    // Upload timeouts. A 100 MB body over consumer broadband (~10 Mbps up)
    // takes ~80 s just for the wire transfer; default Fastify connectionTimeout
    // (10 s) would cut this off before the body reached the handler. 300 s
    // matches the curl --max-time 300 documented in the README — clients that
    // respect this alignment should never see a timeout mismatch.
    connectionTimeout: 300_000,
    keepAliveTimeout: 300_000,
  });

  // Wire persistence.
  const store = new SqliteJobStore(dbPathFor(config));
  const storage = new LocalDiskStorage(storageRootFor(config));

  // External dependencies.
  const openmaic = createOpenMaicClient(config.OPENMAIC_BASE_URL);

  // Format plugins — keyed by id for worker lookup.
  const exporters = Object.fromEntries(listExporters().map((e) => [e.id, e]));

  // Worker pool. The baseUrl we give it is how it addresses ITSELF in webhook
  // payloads — docker-compose resolves 'exporter' within the compose network.
  const selfBaseUrl = `http://exporter:${config.PORT}`;
  const workers = createWorkerPool(config.WORKER_CONCURRENCY, {
    store,
    storage,
    openmaic,
    exporters,
    logger: app.log,
    baseUrl: selfBaseUrl,
  });

  // TTL sweep.
  const cleanup = createCleanup({
    store,
    storage,
    ttlMs: config.JOB_TTL_HOURS * 60 * 60 * 1000,
    intervalMs: config.CLEANUP_INTERVAL_MS,
    logger: app.log,
  });

  // Backpressure. Peak memory on one /from-bundle request with a 100 MB body
  // sits around 300-400 MB (raw JSON string + parsed object tree + decoded
  // Buffers + JSZip staging). Two concurrent requests can trip an OOM on a
  // 1 GB container even with healthy headroom; under-pressure returns 503 +
  // Retry-After before that happens. The health endpoint stays green — we
  // don't want K8s-style liveness probes to restart the pod just because we
  // politely declined a concurrent export.
  //
  // register returns a promise; we await it during buildServer via top-level
  // await isn't available in a plain function, so we fire-and-forget here.
  // Any registration error surfaces via Fastify's own logs.
  void app.register(underPressure, {
    maxEventLoopDelay: 1000,
    maxHeapUsedBytes: 512_000_000,
    maxRssBytes: 900_000_000,
    maxEventLoopUtilization: 0.98,
    message: 'Exporter under heap pressure — retry later',
    retryAfter: 30,
    // Plugin enforces: if healthCheck is set, either healthCheckInterval or
    // exposeStatusRoute must be set too. We don't expose /status (our own
    // /health route is the canonical liveness endpoint), so we just set a
    // low-frequency interval; the check itself is a no-op returning true.
    healthCheck: async () => true,
    healthCheckInterval: 60_000,
    exposeStatusRoute: false,
  });

  // Auth goes before routes so preHandler runs on all of them uniformly.
  installAuth(app, {
    token: config.EXPORTER_AUTH_TOKEN,
    unauthenticated: ['/health'],
  });

  // Register routes. Order doesn't matter for correctness — Fastify resolves them
  // at listen time — but we keep it consistent with the README's walkthrough order.
  void registerHealthRoute(app);
  void registerMetricsRoute(app, { store });
  void registerFormatsRoute(app);
  void registerExportRoute(app, { store, workers });
  void registerExportFromBundleRoute(app, { config });
  void registerJobsRoutes(app, { store, storage });

  return { app, store, workers, cleanup, config };
}

// Graceful shutdown orchestration. Sequence matters:
//   1. app.close() stops accepting new connections (existing are drained).
//   2. cleanup.stop() prevents new TTL-sweep timers from firing.
//   3. workers.drain(ttl) waits for in-flight jobs up to GRACE_MS.
//   4. If drain timed out, abandon still-running jobs so they don't dangle.
//   5. store.close() flushes SQLite last (after any .update() calls in step 4).
export async function shutdown(built: BuiltServer, signal: string): Promise<void> {
  const { app, store, workers, cleanup, config } = built;
  app.log.info({ signal }, 'shutdown initiated');

  try {
    await app.close();
  } catch (err) {
    app.log.error({ err }, 'Fastify close errored (continuing)');
  }
  cleanup.stop();

  const drained = await workers.drain(config.SHUTDOWN_GRACE_MS);
  if (!drained) {
    app.log.warn({ graceMs: config.SHUTDOWN_GRACE_MS }, 'drain timeout — abandoning running jobs');
    await workers.abandonRunning('shutdown timeout');
  } else {
    app.log.info('worker pool drained cleanly');
  }

  try {
    await store.close();
    app.log.info('store closed — shutdown complete');
  } catch (err) {
    app.log.error({ err }, 'store close errored');
  }
}

// `startServer` is the actual bin — loads config, exits non-zero on fail-closed,
// installs signal handlers, listens. Separated from buildServer() so tests can
// instantiate the app in-process without touching signals or the network.
export async function startServer(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    // Log to stderr directly — we don't have a Fastify logger yet.
    // eslint-disable-next-line no-console
    console.error(`FATAL: ${(err as Error).message}`);
    process.exit(1);
  }

  const built = buildServer(config);
  built.workers.start();
  built.cleanup.start();

  const signalHandler = (signal: NodeJS.Signals) => {
    // once(): a second SIGTERM while we're shutting down shouldn't re-enter.
    void shutdown(built, signal).then(
      () => process.exit(0),
      (err) => {
        built.app.log.error({ err }, 'shutdown handler crashed');
        process.exit(1);
      },
    );
  };
  process.once('SIGTERM', signalHandler);
  process.once('SIGINT', signalHandler);

  try {
    await built.app.listen({ port: config.PORT, host: config.HOST });
    built.app.log.info(
      { port: config.PORT, host: config.HOST, formats: listExporters().map((e) => e.id) },
      'exporter ready',
    );
  } catch (err) {
    built.app.log.error({ err }, 'failed to start listener');
    process.exit(1);
  }
}

// Entrypoint — only auto-starts when invoked as the main module. Tests import
// buildServer() directly and never touch this branch.
// Using import.meta.url + process.argv[1] comparison is the ESM equivalent of
// `require.main === module`.
const isDirect = (() => {
  try {
    const thisFile = new URL(import.meta.url).pathname;
    const entry = process.argv[1];
    return Boolean(entry && thisFile.endsWith(entry.replace(/^.*\//, '')));
  } catch {
    return false;
  }
})();

if (isDirect) {
  void startServer();
}
