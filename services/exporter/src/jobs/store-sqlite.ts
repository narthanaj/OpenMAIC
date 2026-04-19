import Database, { type Database as BetterDb, type Statement } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { JobStore } from './store.js';
import type { Job, JobStatus } from './types.js';

// SQLite-backed JobStore.
//
// WAL + synchronous=NORMAL + busy_timeout=5000 is the concurrent-access triplet.
// Without WAL, SQLite's default DELETE journal serializes every reader behind any
// writer, and this service has three concurrent writers (HTTP handler, worker pool,
// TTL sweep) — SQLITE_BUSY would be inevitable under any real load.
//
// All methods look async because the JobStore interface is async (so a future
// remote-store impl doesn't break callers), but better-sqlite3 is synchronous under
// the hood — there's no real I/O wait here, just a Promise.resolve wrapper.

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS jobs (
    id           TEXT PRIMARY KEY,
    format       TEXT NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('pending','running','done','failed')),
    classroom_id TEXT,
    webhook_url  TEXT,
    error        TEXT,
    result_key   TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_status       ON jobs(status);
  CREATE INDEX IF NOT EXISTS idx_jobs_created_at   ON jobs(created_at);
`;

// Row shape as stored by better-sqlite3. Nullable DB columns come back as null
// (not undefined) — we map to Job shape where the same fields are typed `| null`.
interface JobRow {
  id: string;
  format: string;
  status: JobStatus;
  classroom_id: string | null;
  webhook_url: string | null;
  error: string | null;
  result_key: string | null;
  created_at: number;
  updated_at: number;
}

function rowToJob(r: JobRow): Job {
  return {
    id: r.id,
    format: r.format,
    status: r.status,
    classroomId: r.classroom_id,
    webhookUrl: r.webhook_url,
    error: r.error,
    resultKey: r.result_key,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class SqliteJobStore implements JobStore {
  private readonly db: BetterDb;
  private readonly stmts: {
    insert: Statement;
    selectById: Statement<[string]>;
    deleteById: Statement<[string]>;
    selectExpired: Statement<[number]>;
    countByStatus: Statement<[JobStatus]>;
    selectByStatus: Statement<[JobStatus]>;
    selectRecent: Statement<[number]>;
  };

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);

    // Concurrency triplet — MUST run before any other statement.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');

    this.db.exec(CREATE_TABLE);

    this.stmts = {
      insert: this.db.prepare(
        `INSERT INTO jobs (id, format, status, classroom_id, webhook_url, error, result_key, created_at, updated_at)
         VALUES (@id, @format, @status, @classroomId, @webhookUrl, @error, @resultKey, @createdAt, @updatedAt)`,
      ),
      selectById: this.db.prepare(`SELECT * FROM jobs WHERE id = ?`),
      deleteById: this.db.prepare(`DELETE FROM jobs WHERE id = ?`),
      selectExpired: this.db.prepare(`SELECT * FROM jobs WHERE created_at < ?`),
      countByStatus: this.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status = ?`),
      selectByStatus: this.db.prepare(`SELECT * FROM jobs WHERE status = ?`),
      selectRecent: this.db.prepare(
        `SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`,
      ),
    };
  }

  async create(job: Job): Promise<void> {
    this.stmts.insert.run({
      id: job.id,
      format: job.format,
      status: job.status,
      classroomId: job.classroomId,
      webhookUrl: job.webhookUrl,
      error: job.error,
      resultKey: job.resultKey,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  }

  async get(id: string): Promise<Job | null> {
    const row = this.stmts.selectById.get(id) as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  async update(id: string, patch: Partial<Job>): Promise<void> {
    // Build a dynamic UPDATE so we only touch the columns the caller specified.
    // Always bump updated_at regardless. We reject any patch that tries to change
    // the id itself — immutable key.
    const map: Record<keyof Job, string> = {
      id: 'id',
      format: 'format',
      status: 'status',
      classroomId: 'classroom_id',
      webhookUrl: 'webhook_url',
      error: 'error',
      resultKey: 'result_key',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    };

    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    for (const [k, v] of Object.entries(patch) as [keyof Job, Job[keyof Job]][]) {
      if (k === 'id' || k === 'updatedAt') continue;
      const col = map[k];
      if (!col) continue;
      sets.push(`${col} = @${k}`);
      params[k] = v;
    }
    sets.push(`updated_at = @updatedAt`);
    params.updatedAt = Date.now();

    if (sets.length === 1) return; // only updated_at — nothing caller-interesting changed

    const sql = `UPDATE jobs SET ${sets.join(', ')} WHERE id = @id`;
    this.db.prepare(sql).run(params);
  }

  async listExpired(cutoffMs: number): Promise<Job[]> {
    const rows = this.stmts.selectExpired.all(cutoffMs) as JobRow[];
    return rows.map(rowToJob);
  }

  async delete(id: string): Promise<void> {
    this.stmts.deleteById.run(id);
  }

  async countByStatus(status: JobStatus): Promise<number> {
    const row = this.stmts.countByStatus.get(status) as { n: number };
    return row.n;
  }

  async listByStatus(status: JobStatus): Promise<Job[]> {
    const rows = this.stmts.selectByStatus.all(status) as JobRow[];
    return rows.map(rowToJob);
  }

  async listRecent(limit: number): Promise<Job[]> {
    const rows = this.stmts.selectRecent.all(limit) as JobRow[];
    return rows.map(rowToJob);
  }

  async close(): Promise<void> {
    // WAL checkpoint on close so the -wal file is merged into the main db — avoids
    // leaving data in the WAL if the container is re-created with a new volume mount
    // that somehow loses the sidecar files.
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // Non-fatal — worst case the wal replay runs on next open.
    }
    this.db.close();
  }
}
