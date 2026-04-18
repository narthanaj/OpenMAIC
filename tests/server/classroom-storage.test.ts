import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// The module eagerly resolves DATA_DIR at import-time and creates the subdirs then. Every test
// here stubs process.env.DATA_DIR BEFORE re-importing, using vi.resetModules() to force a fresh
// module evaluation.

describe('classroom-storage DATA_DIR resolution', () => {
  let created: string[] = [];

  beforeEach(() => {
    created = [];
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    for (const dir of created) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup — test should not fail on teardown
      }
    }
  });

  it('resolves to <cwd>/data when DATA_DIR is unset', async () => {
    delete process.env.DATA_DIR;
    const mod = await import('@/lib/server/classroom-storage');
    expect(mod.DATA_DIR).toBe(path.join(process.cwd(), 'data'));
    expect(mod.CLASSROOMS_DIR).toBe(path.join(process.cwd(), 'data', 'classrooms'));
    expect(mod.CLASSROOM_JOBS_DIR).toBe(path.join(process.cwd(), 'data', 'classroom-jobs'));
  });

  it('resolves to DATA_DIR env when set, and eagerly creates the subdirs', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'openmaic-storage-test-'));
    created.push(base);
    process.env.DATA_DIR = base;

    const mod = await import('@/lib/server/classroom-storage');
    expect(mod.DATA_DIR).toBe(base);
    expect(mod.CLASSROOMS_DIR).toBe(path.join(base, 'classrooms'));
    expect(mod.CLASSROOM_JOBS_DIR).toBe(path.join(base, 'classroom-jobs'));

    // Side effect: directories must exist on disk after module load.
    expect(existsSync(mod.CLASSROOMS_DIR)).toBe(true);
    expect(existsSync(mod.CLASSROOM_JOBS_DIR)).toBe(true);
    expect(statSync(mod.CLASSROOMS_DIR).isDirectory()).toBe(true);
  });

  it('treats whitespace-only DATA_DIR as unset', async () => {
    process.env.DATA_DIR = '   ';
    const mod = await import('@/lib/server/classroom-storage');
    expect(mod.DATA_DIR).toBe(path.join(process.cwd(), 'data'));
  });

  it('resolves relative DATA_DIR against process.cwd()', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'openmaic-rel-test-'));
    created.push(base);
    // Relative path: use a subdir of our temp dir, but express it relative to cwd via a .. chain.
    const relative = path.relative(process.cwd(), base);
    process.env.DATA_DIR = relative;

    const mod = await import('@/lib/server/classroom-storage');
    expect(mod.DATA_DIR).toBe(base); // path.resolve() anchors to cwd
  });

  it('throws at import when DATA_DIR points at a denylisted system path', async () => {
    process.env.DATA_DIR = '/';
    await expect(import('@/lib/server/classroom-storage')).rejects.toThrow(/protected system path/);
  });

  it('throws at import for other denylisted paths', async () => {
    for (const forbidden of ['/etc', '/usr', '/bin', '/proc']) {
      vi.resetModules();
      process.env.DATA_DIR = forbidden;
      await expect(import('@/lib/server/classroom-storage')).rejects.toThrow(/protected system path/);
    }
  });

  it('wraps unwritable-dir errors with an operator-friendly message', async () => {
    // Point DATA_DIR at a file (not a dir) so mkdirSync fails with ENOTDIR / EEXIST.
    const base = mkdtempSync(path.join(tmpdir(), 'openmaic-bad-test-'));
    created.push(base);
    const filePath = path.join(base, 'iam-a-file');
    // Create a file where the code expects a directory.
    require('fs').writeFileSync(filePath, 'not a dir');
    process.env.DATA_DIR = filePath;

    await expect(import('@/lib/server/classroom-storage')).rejects.toThrow(
      /Failed to initialise DATA_DIR/,
    );
  });
});
