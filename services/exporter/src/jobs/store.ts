import type { Job, JobStatus } from './types.js';

// Driver-agnostic job persistence. The store owns the full lifecycle of a Job row:
// creation, status transitions, listing for TTL sweep and shutdown-abandon sweeps,
// and deletion. Implementations today: SQLite (see store-sqlite.ts). Future: Postgres,
// Redis, anything with at-least-once update semantics.
//
// All methods are async even when the underlying driver is synchronous (better-sqlite3
// is sync) — keeping the interface async means swapping to a remote store later
// doesn't force a signature change on every caller.

export interface JobStore {
  create(job: Job): Promise<void>;

  get(id: string): Promise<Job | null>;

  // Partial update semantics: only the provided keys are written, plus `updatedAt`
  // is always refreshed to Date.now() by the implementation. Callers should NOT
  // set `updatedAt` manually.
  update(id: string, patch: Partial<Job>): Promise<void>;

  // Returns every job with createdAt < cutoffMs, regardless of status. The cleanup
  // sweep uses this to find stale rows to evict along with their ZIPs.
  listExpired(cutoffMs: number): Promise<Job[]>;

  delete(id: string): Promise<void>;

  // Lightweight gauge feeders — prom-client scrape path should stay cheap.
  countByStatus(status: JobStatus): Promise<number>;

  // Used by the shutdown abandon-running sweep: "any job currently in `running`
  // when the service is terminating needs to be marked failed so it doesn't
  // dangle in the UI forever."
  listByStatus(status: JobStatus): Promise<Job[]>;

  // Used by the UI's "Recent jobs" table. Returns the N most recent jobs ordered
  // by createdAt descending, regardless of status. Capped by the caller (route
  // handler enforces an upper bound before calling in).
  listRecent(limit: number): Promise<Job[]>;

  // Driver-specific cleanup. For SQLite this calls db.close(). For a future Postgres
  // pool this would call pool.end(). Called last in the graceful-shutdown handler
  // AFTER all writes have flushed.
  close(): Promise<void>;
}
