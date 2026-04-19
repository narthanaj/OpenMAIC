import type { Readable } from 'node:stream';

// Blob-storage abstraction. Stream-based from day 1 so the interface doesn't need
// to change when we add S3 / MinIO / GCS later (their SDKs produce and consume
// Readable streams natively — forcing Buffer here would either cap object size by
// available RAM or require a refactor downstream).
//
// All four methods are async. Implementations must handle backpressure correctly;
// LocalDiskStorage uses stream/promises.pipeline() which propagates errors and
// cleanly releases file handles on failure.

export interface ExportStorage {
  // Writes `stream` to `key`. Resolves when the underlying sink reports drained.
  // On error, partially-written blobs MUST be removed so a retry starts clean.
  put(key: string, stream: Readable): Promise<void>;

  // Returns a readable stream of the stored bytes. Caller is responsible for piping
  // it (e.g. into an HTTP response). The returned stream emits 'error' if the
  // underlying resource goes away mid-read.
  get(key: string): Promise<Readable>;

  exists(key: string): Promise<boolean>;

  // Idempotent: deleting a missing key is not an error.
  delete(key: string): Promise<void>;

  // Informational — used by the storage-bytes metric. Optional because remote
  // implementations (S3) charge per LIST. LocalDiskStorage implements it as a
  // recursive du; S3 would implement it as `HeadObject` on tracked keys.
  sizeBytes?(): Promise<number>;
}
