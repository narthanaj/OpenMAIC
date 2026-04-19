import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteJobStore } from '@/jobs/store-sqlite.js';
import { newJob } from '@/jobs/types.js';

// Covers the three things that matter for SQLite-backed persistence:
//   1. CRUD correctness (create / get / update / delete round-trip).
//   2. Listing helpers (listExpired, listByStatus, countByStatus).
//   3. WAL mode is actually enabled — we check by reading the pragma back.
//
// Each test gets its own tmpdir so state doesn't leak between cases. The store
// is explicitly `close()`d in afterEach — also validates that close() is idempotent
// and safe to call multiple times (it isn't — better-sqlite3 throws on double-close —
// but we only close once per test so this is fine).

describe('SqliteJobStore', () => {
  let dir: string;
  let dbPath: string;
  let store: SqliteJobStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'exporter-sqlite-'));
    dbPath = join(dir, 'jobs.db');
    store = new SqliteJobStore(dbPath);
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('enables WAL mode at open', () => {
    // Read the pragma back via a quick second connection.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3');
    const peek = new Database(dbPath);
    const mode = peek.pragma('journal_mode', { simple: true });
    expect(String(mode).toLowerCase()).toBe('wal');
    peek.close();
  });

  it('round-trips a job through create → get', async () => {
    const job = newJob('scorm1.2', 'cls_xyz', null);
    await store.create(job);
    const found = await store.get(job.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(job.id);
    expect(found!.classroomId).toBe('cls_xyz');
    expect(found!.status).toBe('pending');
  });

  it('update writes only the patched fields and bumps updatedAt', async () => {
    const job = newJob('scorm1.2', 'cls_1', null);
    await store.create(job);
    const before = await store.get(job.id);
    await new Promise((r) => setTimeout(r, 5)); // ensure timestamps differ

    await store.update(job.id, { status: 'running' });
    const after = await store.get(job.id);
    expect(after!.status).toBe('running');
    expect(after!.updatedAt).toBeGreaterThan(before!.updatedAt);
    // classroomId not touched by patch — must be unchanged.
    expect(after!.classroomId).toBe('cls_1');
  });

  it('countByStatus + listByStatus reflect current state', async () => {
    const a = newJob('scorm1.2', 'c1', null);
    const b = newJob('scorm1.2', 'c2', null);
    await store.create(a);
    await store.create(b);
    await store.update(b.id, { status: 'running' });

    expect(await store.countByStatus('pending')).toBe(1);
    expect(await store.countByStatus('running')).toBe(1);
    const running = await store.listByStatus('running');
    expect(running.map((j) => j.id)).toEqual([b.id]);
  });

  it('listExpired returns jobs created before the cutoff', async () => {
    const old = newJob('scorm1.2', 'old', null);
    old.createdAt = Date.now() - 10_000;
    await store.create(old);
    const fresh = newJob('scorm1.2', 'fresh', null);
    await store.create(fresh);

    const cutoff = Date.now() - 5_000;
    const expired = await store.listExpired(cutoff);
    expect(expired.map((j) => j.id)).toEqual([old.id]);
  });

  it('delete removes the row', async () => {
    const job = newJob('scorm1.2', 'c', null);
    await store.create(job);
    expect(await store.get(job.id)).not.toBeNull();
    await store.delete(job.id);
    expect(await store.get(job.id)).toBeNull();
  });

  it('listRecent returns newest-first, capped at limit', async () => {
    // Seed five jobs with monotonically-increasing createdAt.
    const ids = [] as string[];
    for (let i = 0; i < 5; i++) {
      const j = newJob('scorm1.2', `c_${i}`, null);
      j.createdAt = 1_000_000 + i * 1000;
      j.updatedAt = j.createdAt;
      await store.create(j);
      ids.push(j.id);
    }
    const recent3 = await store.listRecent(3);
    expect(recent3).toHaveLength(3);
    // Newest first — the last-inserted should lead.
    expect(recent3[0]!.classroomId).toBe('c_4');
    expect(recent3[1]!.classroomId).toBe('c_3');
    expect(recent3[2]!.classroomId).toBe('c_2');
    // Limit larger than row count returns all.
    const all = await store.listRecent(100);
    expect(all).toHaveLength(5);
  });

  it('handles sequential writes without SQLITE_BUSY (WAL active)', async () => {
    // Sanity: serialized writes of 50 jobs back-to-back should never trip a
    // SQLITE_BUSY under WAL + busy_timeout. If this ever starts failing, the
    // pragmas in store-sqlite.ts regressed.
    const jobs = Array.from({ length: 50 }, (_, i) => newJob('scorm1.2', `c_${i}`, null));
    for (const j of jobs) await store.create(j);
    expect(await store.countByStatus('pending')).toBe(50);
  });
});
