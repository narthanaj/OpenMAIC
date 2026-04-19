import { z } from 'zod';

// Fail-closed config loader. Every knob comes from an env var, validated by zod.
// Missing or invalid values throw; server.ts catches and exits non-zero so Docker
// sees a restart loop (highly visible) instead of a silently degraded service.
//
// The one critical guard is EXPORTER_AUTH_TOKEN — refusing to start without it is
// the "fail closed" part: if ops forgets to set it, the container won't accidentally
// run unauthenticated on whatever network it's bound to.

const ConfigSchema = z.object({
  // Bearer token for all auth-gated routes. Minimum 16 chars so accidental empty /
  // placeholder strings are caught at startup instead of silently weakening auth.
  EXPORTER_AUTH_TOKEN: z
    .string()
    .min(16, 'EXPORTER_AUTH_TOKEN must be at least 16 characters (use `openssl rand -hex 32`)'),

  OPENMAIC_BASE_URL: z.string().url().default('http://openmaic:3000'),

  // TTL for completed/failed job records and their stored ZIPs, in hours.
  JOB_TTL_HOURS: z.coerce.number().int().positive().default(24),

  // Number of parallel export workers. Exports are CPU-light (JSZip + string work)
  // but RAM-bound for large classrooms, so we default low and let ops scale up.
  WORKER_CONCURRENCY: z.coerce.number().int().positive().max(32).default(2),

  // Grace period for in-flight jobs on SIGTERM before they're abandoned.
  SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().default(30_000),

  // TTL sweep interval. 1h is a reasonable balance — frequent enough that disk
  // doesn't drift too far, rare enough that we're not I/O-churning on a nearly-empty DB.
  CLEANUP_INTERVAL_MS: z.coerce.number().int().positive().default(60 * 60 * 1000),

  DATA_DIR: z.string().default('/data'),

  JOB_STORE_DRIVER: z.enum(['sqlite']).default('sqlite'),
  EXPORT_STORAGE_DRIVER: z.enum(['local']).default('local'),

  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),

  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),

  // Env-gated `global.gc()` after a large response finishes. Only useful when
  // the `/from-bundle` route has been driving heap pressure — V8's LOS doesn't
  // reclaim big allocations until a full GC cycle, so repeated ~100 MB bodies
  // can fragment the heap into OOM even under nominal RSS. Requires the
  // Dockerfile CMD to pass `--expose-gc`; otherwise `global.gc` is undefined
  // and the hook is a no-op. Leave false by default.
  EXPORTER_GC_ON_RESPONSE: z
    .union([z.boolean(), z.string()])
    .default(false)
    .transform((v) => v === true || v === 'true' || v === '1'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`invalid exporter config:\n${issues}`);
  }
  return result.data;
}

// Derived paths — kept alongside the config so tests can mock DATA_DIR and assert
// the derived shape without re-deriving the path arithmetic.
export function dbPathFor(config: Config): string {
  return `${config.DATA_DIR.replace(/\/+$/, '')}/jobs.db`;
}

export function storageRootFor(config: Config): string {
  return `${config.DATA_DIR.replace(/\/+$/, '')}/exports`;
}
