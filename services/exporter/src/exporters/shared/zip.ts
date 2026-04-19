import JSZip from 'jszip';
import { Readable } from 'node:stream';

// Generic streaming ZIP assembler shared by every export format. Originally lived
// under scorm1_2/; moved here once the html format was added so it doesn't have
// to cross-import from a sibling plugin.
//
// Streams the ZIP bytes via `generateNodeStream()` so the full pipeline
// (exporter → storage → HTTP download) stays zero-buffer.

export interface ZipFile {
  path: string;                    // path inside the ZIP (always forward-slash)
  content: string | Uint8Array;
}

export function buildExportZipStream(files: ZipFile[]): Readable {
  const zip = new JSZip();
  for (const f of files) {
    zip.file(f.path, f.content);
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
