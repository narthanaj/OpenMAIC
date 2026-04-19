import JSZip from 'jszip';
import { Readable } from 'node:stream';

// Generic streaming ZIP assembler shared by every export format. Originally lived
// under scorm1_2/; moved here once the html format was added so it doesn't have
// to cross-import from a sibling plugin.
//
// Streams the ZIP bytes via `generateNodeStream()` — chunks go straight from
// JSZip → Fastify → socket, so peak heap stays flat even for ~100 MB exports.
// Do NOT swap this for `generateAsync({type:'nodebuffer'})`: that variant builds
// the entire ZIP in memory before emitting the first byte, doubling peak RAM
// per in-flight export and wrecking our `@fastify/under-pressure` budget.

export interface ZipFile {
  path: string;                    // path inside the ZIP (always forward-slash)
  content: string | Uint8Array;
  // Per-entry compression override. DEFLATE (default) is right for text —
  // HTML, XML, JSON, JS, CSS compress 70-90%. STORE (no compression) is
  // right for already-compressed binaries — MP3, AAC, PNG, JPEG, WebP —
  // where DEFLATE wastes CPU for ~0% savings and occasionally *grows* the
  // output by the DEFLATE header overhead. Per-entry (not per-archive)
  // because a SCORM export legitimately mixes both categories.
  compression?: 'DEFLATE' | 'STORE';
}

export function buildExportZipStream(files: ZipFile[]): Readable {
  const zip = new JSZip();
  for (const f of files) {
    // JSZip accepts a per-file options object with its own `compression` /
    // `compressionOptions`. When omitted, the entry inherits the archive-level
    // defaults set on `generateNodeStream()` below.
    if (f.compression) {
      zip.file(f.path, f.content, {
        compression: f.compression,
        compressionOptions: f.compression === 'DEFLATE' ? { level: 6 } : undefined,
      });
    } else {
      zip.file(f.path, f.content);
    }
  }
  // JSZip types `.generateNodeStream()` as `NodeJS.ReadableStream` — the structural
  // supertype — but at runtime it IS a Node Readable. The cast via `unknown` is
  // safe: the returned object has all the Readable surface we rely on.
  return zip.generateNodeStream({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    streamFiles: true,
  }) as unknown as Readable;
}
