import type { Readable } from 'node:stream';
import type { Classroom } from '../validation/classroom.js';

// Per-export caller hints. None are required; SCORM 1.2 v1 ignores these
// but they're defined here so future formats (xAPI activity IDs, cmi5 profile
// choices, etc.) don't have to widen the interface.
export interface ExportOptions {
  // Optional override for the package's display title. Defaults to classroom.stage.name.
  title?: string;
  // Optional language tag for SCORM/xAPI metadata. Defaults to classroom.stage.language ?? 'en'.
  language?: string;
  // Binary blobs keyed by in-ZIP path (`audio/<id>.mp3`, `media/<id>.png`). When
  // present, the exporter copies them into the output ZIP with STORE compression
  // (they're already compressed; DEFLATE is wasted CPU). Populated by the
  // /from-bundle route after decoding the classroom manifest's _embeddedAudio /
  // _embeddedMedia base64 maps; empty/undefined for the legacy pull-mode path.
  mediaBundle?: Map<string, Buffer>;
  // Reserved for format-specific options. Formats should namespace under their id.
  extra?: Record<string, unknown>;
}

// The one-method contract every export format implements. Returns a Readable of the
// packaged bytes — no Buffer intermediate — so the full pipeline (exporter → storage
// → HTTP download) is streaming end-to-end.
export interface ContentExporter {
  // Stable identifier used in URL paths (`POST /export/:id`) and metric labels.
  // Kebab-ish lowercase (`scorm1.2`, `scorm2004`, `xapi`, `cmi5`, `h5p`).
  readonly id: string;

  // Human-readable name, shown in logs and error messages.
  readonly name: string;

  // Produces the format-specific package bytes. Implementations MUST:
  //   - Not mutate `classroom`.
  //   - Return a stream that emits 'error' on internal failures (do not throw mid-stream
  //     except via stream.destroy(err)).
  //   - Not hold the entire output in memory; use JSZip.generateNodeStream() or equivalent.
  export(classroom: Classroom, opts?: ExportOptions): Promise<Readable>;
}
