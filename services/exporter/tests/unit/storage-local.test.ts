import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { LocalDiskStorage } from '@/storage/local.js';

// Stream roundtrip: put(Readable) → get(Readable) → bytes match.
// Also covers the key-hygiene checks (no '..' traversal) and the sizeBytes scan.

describe('LocalDiskStorage', () => {
  let root: string;
  let storage: LocalDiskStorage;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'exporter-storage-'));
    storage = new LocalDiskStorage(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function collect(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  it('put → get roundtrips bytes losslessly', async () => {
    const payload = Buffer.alloc(128 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 37) & 0xff;

    await storage.put('scorm1.2/job1.zip', Readable.from(payload));
    const stream = await storage.get('scorm1.2/job1.zip');
    const roundtrip = await collect(stream);
    expect(roundtrip.equals(payload)).toBe(true);
  });

  it('exists returns true after put and false for absent keys', async () => {
    await storage.put('a/b.bin', Readable.from(Buffer.from('hello')));
    expect(await storage.exists('a/b.bin')).toBe(true);
    expect(await storage.exists('a/missing.bin')).toBe(false);
  });

  it('delete is idempotent — missing key does not throw', async () => {
    await storage.put('x.bin', Readable.from(Buffer.from('1')));
    await storage.delete('x.bin');
    // Second delete on same (now missing) key.
    await expect(storage.delete('x.bin')).resolves.toBeUndefined();
    // Delete on a never-written key.
    await expect(storage.delete('never.bin')).resolves.toBeUndefined();
  });

  it('rejects key traversal', async () => {
    await expect(
      storage.put('../escape.bin', Readable.from(Buffer.from('nope'))),
    ).rejects.toThrow(/invalid storage key/);
  });

  it('sizeBytes sums stored bytes', async () => {
    await storage.put('dir/a', Readable.from(Buffer.alloc(10)));
    await storage.put('dir/b', Readable.from(Buffer.alloc(20)));
    const total = await storage.sizeBytes();
    expect(total).toBe(30);
  });

  it('put cleans up partial on stream error', async () => {
    // A stream that emits one chunk then errors. pipeline() should propagate the
    // error; LocalDiskStorage should rm the partial file so it's not left behind.
    const bad = new Readable({
      read() {
        this.push(Buffer.from('partial'));
        process.nextTick(() => this.destroy(new Error('synthetic failure')));
      },
    });
    await expect(storage.put('maybe.bin', bad)).rejects.toThrow('synthetic failure');
    expect(await storage.exists('maybe.bin')).toBe(false);
  });
});
