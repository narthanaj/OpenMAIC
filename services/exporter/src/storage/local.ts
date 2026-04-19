import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rm, stat, readdir } from 'node:fs/promises';
import { join, dirname, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { ExportStorage } from './types.js';

// Filesystem-backed blob storage. All keys are treated as paths relative to `root`.
//
// Key hygiene: we reject keys with '..' segments or absolute paths so callers can't
// traverse out of `root`. Keys MAY contain subdirectories (/) — the SCORM exporter
// uses "scorm1.2/<jobId>.zip" shape so different formats don't collide.

function sanitizeKey(key: string): string {
  if (!key || key.includes('..')) {
    throw new Error(`invalid storage key: ${key}`);
  }
  // Normalize to forward-slash, then re-join with platform separator.
  const parts = key.split('/').filter(Boolean);
  if (parts.length === 0) throw new Error(`empty storage key`);
  return parts.join(sep);
}

export class LocalDiskStorage implements ExportStorage {
  constructor(private readonly root: string) {}

  private pathFor(key: string): string {
    return join(this.root, sanitizeKey(key));
  }

  async put(key: string, stream: Readable): Promise<void> {
    const dest = this.pathFor(key);
    await mkdir(dirname(dest), { recursive: true });

    const sink = createWriteStream(dest);
    try {
      await pipeline(stream, sink);
    } catch (err) {
      // Clean up partial on failure so a retry starts fresh. rm is idempotent
      // with { force: true } so missing file is fine.
      await rm(dest, { force: true }).catch(() => {});
      throw err;
    }
  }

  async get(key: string): Promise<Readable> {
    const src = this.pathFor(key);
    if (!existsSync(src)) throw new Error(`storage key not found: ${key}`);
    return createReadStream(src);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.pathFor(key));
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async sizeBytes(): Promise<number> {
    // Recursive `du` — cheap enough for the export root (hundreds of files at most).
    // For a remote storage backend we'd maintain a counter in the store instead.
    async function walk(dir: string): Promise<number> {
      let total = 0;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 0;
        throw err;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          total += await walk(full);
        } else if (entry.isFile()) {
          const s = await stat(full);
          total += s.size;
        }
      }
      return total;
    }
    return walk(this.root);
  }
}
