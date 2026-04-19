import type { Classroom } from '../validation/classroom.js';
import { ClassroomSchema } from '../validation/classroom.js';

// Decoder for the `/export/:format/from-bundle` sync route. Accepts the output
// of OpenMAIC's DevTools classroom-extraction snippet (documented in
// services/ui/README.md): a JSON blob shaped like a ClassroomManifest plus
// `_embeddedAudio` + `_embeddedMedia` maps of in-ZIP paths → `data:` URLs.
//
// Three hardening layers before a single byte of base64 payload reaches the
// ZIP writer — the input is untrusted (it came over HTTP) and we want every
// rejection to name a *structural* reason, never an interpolated value:
//
//   1. Unicode-safe key regex with filename + extension length caps. Stops
//      path-traversal (`../etc/passwd`), normalization-bypass U+2044 tricks,
//      and pathologically long keys before they touch the ZIP writer.
//   2. Comma-slice base64 decode. `Buffer.from(dataUrl, 'base64')` silently
//      corrupts the output because it tries to decode the `data:audio/mp3;base64,`
//      prefix as base64 data. We slice past the first `,` and decode only the
//      payload.
//   3. MIME ↔ bucket cross-check. An `audio/<id>.<ext>` key that carries a
//      `data:image/png;base64,...` payload is a confused-deputy bug waiting
//      to happen (a PNG smuggled into the SCORM audio slot). The `audio`
//      bucket requires an `audio/*` MIME; `media` accepts audio/image/video.

// Extension length 2–5 covers mp3, wav, aac, flac, ogg, webm, m4a, jpg, jpeg,
// png, gif, webp, svg. Filename length cap of 100 bounds regex backtracking
// cost AND the eventual ZIP-entry path length (SCORM/HTML players behave
// unpredictably with 4KB filenames).
//
// The `u` flag forces Unicode-aware matching, which is what makes this
// regex safe against normalization tricks: without it, a multi-byte U+2044
// (⁄) might sneak past a `/`-based anchor on some engines. With `u`, the
// character class `[A-Za-z0-9_.-]` genuinely means those ASCII bytes only.
const AUDIO_KEY_RE = /^audio\/[A-Za-z0-9_.-]{1,100}\.[A-Za-z0-9]{2,5}$/u;
const MEDIA_KEY_RE = /^media\/[A-Za-z0-9_.:-]{1,100}\.[A-Za-z0-9]{2,5}$/u;

export type BundleDecodeReason =
  | 'body_not_object'
  | 'embedded_audio_not_object'
  | 'embedded_media_not_object'
  | 'invalid_audio_key'
  | 'invalid_media_key'
  | 'invalid_data_url'
  | 'invalid_base64'
  | 'mime_bucket_mismatch'
  | 'classroom_validation_failed';

// Structured error — carries a *reason code* plus a small dict of enumerated
// context keys. Crucially: error messages are built from the reason code
// alone, never interpolating user-supplied strings (the key, the MIME type,
// the payload). Feedback #14 in the plan: "Error messages never interpolate
// request-sourced strings." Logger redaction covers logs, but response
// bodies are a separate surface — a naive template literal here would
// leak 100 MB of base64 into a 400 response.
export class BundleDecodeError extends Error {
  readonly code: BundleDecodeReason;
  readonly context: Record<string, string | number | undefined>;
  constructor(code: BundleDecodeReason, context: Record<string, string | number | undefined> = {}) {
    super(code);
    this.code = code;
    this.context = context;
    this.name = 'BundleDecodeError';
  }
}

// Data-URL decoder. Structure: `data:<mime>;base64,<payload>`. The comma
// is the critical separator — everything before it is metadata, everything
// after is the payload. Naively passing the full string to Buffer.from
// silently decodes the metadata as base64 too, which corrupts every audio
// file by 20–40 bytes at the head (inaudible glitch + invalid frames).
function dataUrlToBuffer(dataUrl: string, bucket: 'audio' | 'media'): Buffer {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    throw new BundleDecodeError('invalid_data_url', { bucket });
  }
  const commaIndex = dataUrl.indexOf(',');
  if (commaIndex < 0) {
    throw new BundleDecodeError('invalid_data_url', { bucket });
  }
  // `data:audio/mpeg;base64,<payload>` → header = `audio/mpeg;base64` (after
  // slice(5) strips `data:`). toLowerCase so `Audio/MPEG` and `audio/mpeg`
  // hit the same branches.
  const header = dataUrl.slice(5, commaIndex).toLowerCase();
  if (!header.includes('base64')) {
    throw new BundleDecodeError('invalid_data_url', { bucket });
  }
  const mime = header.split(';')[0] ?? '';

  // Bucket cross-check. `audio/` slots must carry audio; `media/` is the
  // catchall and accepts audio/image/video. The plan calls this "prevents
  // the smuggle a PNG inside an .mp3 slot confused-deputy path."
  if (bucket === 'audio' && !mime.startsWith('audio/')) {
    throw new BundleDecodeError('mime_bucket_mismatch', { bucket, observedMime: mime });
  }
  if (bucket === 'media' && !/^(audio|video|image)\//.test(mime)) {
    throw new BundleDecodeError('mime_bucket_mismatch', { bucket, observedMime: mime });
  }

  const payload = dataUrl.slice(commaIndex + 1);
  // Node's base64 decoder is lenient (ignores whitespace, missing padding),
  // which is fine — the DevTools snippet uses FileReader.readAsDataURL()
  // which emits RFC 4648 base64 (no whitespace). We still guard against
  // completely empty payloads to give a clean error rather than producing
  // a zero-byte audio entry later.
  const buf = Buffer.from(payload, 'base64');
  if (buf.length === 0) {
    throw new BundleDecodeError('invalid_base64', { bucket });
  }
  return buf;
}

export interface EmbeddedBundle {
  classroom: Classroom;
  mediaBundle: Map<string, Buffer>;
}

// Walks an `_embedded*` map, validates every key against its regex, decodes
// every value, and flattens into the returned bundle Map keyed by the in-ZIP
// path. Splits key validation and value decoding so a bad key short-circuits
// before we spend CPU on a 10 MB base64 decode.
function decodeEmbeddedMap(
  raw: unknown,
  bucket: 'audio' | 'media',
  keyRe: RegExp,
  out: Map<string, Buffer>,
  reasonBucket: 'embedded_audio_not_object' | 'embedded_media_not_object',
  invalidKeyReason: 'invalid_audio_key' | 'invalid_media_key',
): void {
  if (raw == null) return;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BundleDecodeError(reasonBucket);
  }
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!keyRe.test(path)) {
      // Don't interpolate `path` into the error — response-body discipline.
      throw new BundleDecodeError(invalidKeyReason, { bucket });
    }
    if (typeof value !== 'string') {
      throw new BundleDecodeError('invalid_data_url', { bucket });
    }
    // Last-writer-wins on duplicate keys — deterministic and matches how
    // JSZip itself resolves .file(path, data) called twice for the same
    // path, so our Map's semantics align with what the ZIP writer would
    // do if we handed it overlapping entries.
    out.set(path, dataUrlToBuffer(value, bucket));
  }
}

// The public entry point. Takes the parsed request body (already through
// JSON.parse at the Fastify layer) and returns a validated Classroom +
// decoded media Map. Failure modes are all BundleDecodeError; the route
// handler maps them to 400 responses with the reason code as `detail`.
export function parseEmbeddedBundle(body: unknown): EmbeddedBundle {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    throw new BundleDecodeError('body_not_object');
  }
  const obj = body as Record<string, unknown>;

  const mediaBundle = new Map<string, Buffer>();
  decodeEmbeddedMap(
    obj._embeddedAudio,
    'audio',
    AUDIO_KEY_RE,
    mediaBundle,
    'embedded_audio_not_object',
    'invalid_audio_key',
  );
  decodeEmbeddedMap(
    obj._embeddedMedia,
    'media',
    MEDIA_KEY_RE,
    mediaBundle,
    'embedded_media_not_object',
    'invalid_media_key',
  );

  // Strip the base64 maps before handing the body to the classroom schema —
  // ClassroomSchema uses .passthrough() which means unknown keys survive,
  // and we don't want ~100 MB of base64 blobs lingering in the Classroom
  // object graph while the exporter runs.
  const { _embeddedAudio: _a, _embeddedMedia: _m, ...classroomInput } = obj;
  void _a;
  void _m;

  const parsed = ClassroomSchema.safeParse(classroomInput);
  if (!parsed.success) {
    // Pass the zod issue list through as `issues` — these are already
    // safe (path + structural message) and match the shape the existing
    // /export/:format route already returns, so clients have one error
    // schema to parse.
    const err = new BundleDecodeError('classroom_validation_failed');
    (err as BundleDecodeError & { issues: unknown }).issues = parsed.error.issues.map((i) => ({
      path: i.path,
      message: i.message,
    }));
    throw err;
  }

  return { classroom: parsed.data, mediaBundle };
}

// Regex exports for tests — the unit test exercises boundary cases
// (traversal, normalization, length) and we want the same constants, not
// a drifted copy.
export const _internals = { AUDIO_KEY_RE, MEDIA_KEY_RE, dataUrlToBuffer };
