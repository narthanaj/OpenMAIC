import Fastify, { type FastifyInstance } from 'fastify';
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
    },
    // bodyLimit stays at Fastify's default (1 MB). Pull-mode request bodies are
    // ~100 bytes ({classroomId, webhookUrl?}); big payloads went away when the
    // UI moved to local-first browser-side zipping.
    // routerOptions.ignoreTrailingSlash makes /export and /export/ equivalent —
    // defensive against any nginx rewrite asymmetry. Fastify 5+ nests router flags
    // under `routerOptions`; passing `ignoreTrailingSlash` top-level logs a
    // deprecation warning (removed in Fastify 6).
    routerOptions: {
      ignoreTrailingSlash: true,
    },
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
