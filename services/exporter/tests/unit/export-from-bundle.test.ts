import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { buildServer } from '@/server.js';
import type { Config } from '@/config.js';
import { parseEmbeddedBundle, BundleDecodeError } from '@/sources/bundle.js';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// End-to-end tests for the sync `/export/:format/from-bundle` route.
//
// Strategy: build a fully wired Fastify app (same builder the real server
// uses), inject a synthetic embedded bundle, and validate the streamed ZIP's
// internal structure — NOT byte-equality against a fixture, because JSZip
// stamps mtime into every entry and we don't want test flakes on disk IO
// ordering or clock skew.

// Tiny 40-byte "fake MP3" — enough that the STORE-compressed entry is
// trivially distinguishable from a DEFLATE'd text file, and small enough
// that the whole test runs in milliseconds.
const FAKE_MP3 = Buffer.from([
  0xff, 0xfb, 0x90, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);
const FAKE_MP3_DATA_URL = `data:audio/mpeg;base64,${FAKE_MP3.toString('base64')}`;

const TOKEN = '0123456789abcdef0123456789abcdef'; // 32 chars — passes config's min 16.

// A manifest-shaped body matching what the DevTools snippet produces. Key
// structural notes: no id on stage/scene (manifest strips them), audioRef
// on the speech action instead of audioId, and the embedded map keyed by
// in-ZIP path.
function makeBundleBody() {
  return {
    formatVersion: 1,
    exportedAt: '2026-04-18T00:00:00.000Z',
    appVersion: '0.1.1-test',
    stage: { name: 'Bundle Test', language: 'en' },
    scenes: [
      {
        type: 'slide',
        title: 'Hello',
        order: 0,
        actions: [
          { type: 'speech', id: 'sp1', text: 'Hello class.', audioRef: 'audio/tts_sp1.mp3' },
        ],
      },
    ],
    agents: [],
    mediaIndex: {
      'audio/tts_sp1.mp3': { type: 'audio', format: 'mp3' },
    },
    _embeddedAudio: {
      'audio/tts_sp1.mp3': FAKE_MP3_DATA_URL,
    },
    _embeddedMedia: {},
  };
}

let dataDir: string;
let config: Config;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'exporter-from-bundle-'));
  config = {
    EXPORTER_AUTH_TOKEN: TOKEN,
    OPENMAIC_BASE_URL: 'http://openmaic:3000',
    JOB_TTL_HOURS: 24,
    WORKER_CONCURRENCY: 1,
    SHUTDOWN_GRACE_MS: 1000,
    CLEANUP_INTERVAL_MS: 60_000,
    DATA_DIR: dataDir,
    JOB_STORE_DRIVER: 'sqlite',
    EXPORT_STORAGE_DRIVER: 'local',
    LOG_LEVEL: 'error',
    PORT: 0,
    HOST: '127.0.0.1',
    EXPORTER_GC_ON_RESPONSE: false,
  } as Config;
});

afterEach(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

describe('POST /export/:format/from-bundle — decoder', () => {
  it('accepts a well-formed bundle and returns a ZIP with audio stored (not deflated)', async () => {
    const built = buildServer(config);
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/export/scorm1.2/from-bundle',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        payload: makeBundleBody(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/zip/);
      expect(res.headers['content-disposition']).toMatch(/attachment;/);

      const zip = await JSZip.loadAsync(res.rawPayload);

      // Audio entry present under audio/.
      const audio = zip.file('audio/tts_sp1.mp3');
      expect(audio).toBeTruthy();

      // STORE method (JSZip's internal flag) — reaching into the private
      // `_data` slot is the only way to inspect compression-per-entry from
      // a loaded archive. The field is stable across JSZip 3.x. If a
      // future upgrade breaks this, the test name still tells future-me
      // what the intent was.
      const audioInternal = audio as unknown as { _data?: { compression?: { magic?: string } } };
      expect(audioInternal._data?.compression?.magic).toBe('\x00\x00');

      // Manifest file is DEFLATE'd.
      const manifest = zip.file('imsmanifest.xml');
      const manifestInternal = manifest as unknown as { _data?: { compression?: { magic?: string } } };
      expect(manifestInternal._data?.compression?.magic).toBe('\x08\x00');

      // Manifest lists the audio file so LMSs that check package integrity
      // don't flag it as an orphan.
      const manifestText = (await manifest?.async('string')) ?? '';
      expect(manifestText).toMatch(/<file href="audio\/tts_sp1\.mp3"\/>/);

      // Scene HTML has an <audio> tag pointing at the bundled file.
      const scene = await zip.file('scenes/001.html')?.async('string');
      expect(scene).toMatch(/<audio[^>]+src="\.\.\/audio\/tts_sp1\.mp3"/);
      // α.3: the scene HTML embeds an inline timeline payload the runtime
      // parses, and pulls in ../timeline.js relative to scenes/ (runtime.js
      // stays unchanged for LMS compat).
      expect(scene).toMatch(/<script type="application\/json" id="timeline">/);
      expect(scene).toMatch(/<script src="\.\.\/timeline\.js" defer><\/script>/);
      // Gate overlay DOM so the first audio.play() lands after a user gesture.
      expect(scene).toMatch(/id="timeline-gate"/);
      // α.3: timeline.js is present at the ZIP root (DEFLATE-compressed).
      const timelineJs = zip.file('timeline.js');
      expect(timelineJs).toBeTruthy();
      const timelineInternal = timelineJs as unknown as { _data?: { compression?: { magic?: string } } };
      expect(timelineInternal._data?.compression?.magic).toBe('\x08\x00');
      const timelineText = (await timelineJs?.async('string')) ?? '';
      expect(timelineText).toMatch(/OpenMAIC timeline runtime/);
      // SCORM manifest lists timeline.js as a resource dependency.
      expect(manifestText).toMatch(/<file href="timeline\.js"\/>/);

      // Round-trip the bytes — they should match our fake MP3 exactly.
      const audioBytes = await audio?.async('nodebuffer');
      expect(audioBytes).toEqual(FAKE_MP3);
    } finally {
      await built.app.close();
      await built.store.close();
    }
  });

  it('rejects a path-traversal key with 400 (no file written to the response)', async () => {
    const built = buildServer(config);
    try {
      const body = makeBundleBody();
      // @ts-expect-error — intentionally malformed
      body._embeddedAudio = { '../../etc/passwd': FAKE_MP3_DATA_URL };

      const res = await built.app.inject({
        method: 'POST',
        url: '/export/scorm1.2/from-bundle',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        payload: body,
      });

      expect(res.statusCode).toBe(400);
      const json = res.json() as { error: string; detail: string };
      expect(json.error).toBe('validation_failed');
      expect(json.detail).toBe('invalid_audio_key');
      // Critical: the offending key MUST NOT be echoed back — error
      // messages never interpolate request-sourced strings.
      expect(JSON.stringify(json)).not.toContain('../../etc/passwd');
    } finally {
      await built.app.close();
      await built.store.close();
    }
  });

  it('rejects a PNG-smuggled-into-audio-slot with mime_bucket_mismatch', async () => {
    const built = buildServer(config);
    try {
      const body = makeBundleBody();
      body._embeddedAudio = {
        'audio/tts_sp1.mp3':
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      };

      const res = await built.app.inject({
        method: 'POST',
        url: '/export/scorm1.2/from-bundle',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        payload: body,
      });

      expect(res.statusCode).toBe(400);
      const json = res.json() as { detail: string; observedMime: string };
      expect(json.detail).toBe('mime_bucket_mismatch');
      expect(json.observedMime).toBe('image/png');
    } finally {
      await built.app.close();
      await built.store.close();
    }
  });

  it('rejects wrong Content-Type before the JSON parser runs', async () => {
    const built = buildServer(config);
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/export/scorm1.2/from-bundle',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'text/plain',
        },
        payload: 'not-json',
      });

      expect(res.statusCode).toBe(415);
    } finally {
      await built.app.close();
      await built.store.close();
    }
  });

  it('rejects an unknown format with 404', async () => {
    const built = buildServer(config);
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/export/hyperzapian/from-bundle',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        payload: makeBundleBody(),
      });

      expect(res.statusCode).toBe(404);
    } finally {
      await built.app.close();
      await built.store.close();
    }
  });

  it('requires a bearer token', async () => {
    const built = buildServer(config);
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/export/scorm1.2/from-bundle',
        headers: { 'content-type': 'application/json' },
        payload: makeBundleBody(),
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
      await built.store.close();
    }
  });

  it('HTML format also emits audio entries with STORE compression', async () => {
    const built = buildServer(config);
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/export/html/from-bundle',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        payload: makeBundleBody(),
      });

      expect(res.statusCode).toBe(200);
      const zip = await JSZip.loadAsync(res.rawPayload);
      const audio = zip.file('audio/tts_sp1.mp3');
      expect(audio).toBeTruthy();
      const audioInternal = audio as unknown as { _data?: { compression?: { magic?: string } } };
      expect(audioInternal._data?.compression?.magic).toBe('\x00\x00');
      const scene = await zip.file('scenes/001.html')?.async('string');
      expect(scene).toMatch(/<audio[^>]+src="\.\.\/audio\/tts_sp1\.mp3"/);
      // α.3 — HTML export also ships timeline.js + inline timeline JSON.
      expect(zip.file('timeline.js')).toBeTruthy();
      expect(scene).toMatch(/<script type="application\/json" id="timeline">/);
      expect(scene).toMatch(/<script src="\.\.\/timeline\.js" defer><\/script>/);
      expect(scene).toMatch(/id="timeline-gate"/);
    } finally {
      await built.app.close();
      await built.store.close();
    }
  });
});

describe('parseEmbeddedBundle — decoder units', () => {
  it('strips _embedded* keys from the returned Classroom', () => {
    const body = makeBundleBody();
    const { classroom } = parseEmbeddedBundle(body);
    expect((classroom as unknown as Record<string, unknown>)._embeddedAudio).toBeUndefined();
    expect((classroom as unknown as Record<string, unknown>)._embeddedMedia).toBeUndefined();
  });

  it('rejects body that is an array (body_not_object)', () => {
    expect(() => parseEmbeddedBundle([] as unknown)).toThrow(BundleDecodeError);
    try {
      parseEmbeddedBundle([] as unknown);
    } catch (e) {
      expect((e as BundleDecodeError).code).toBe('body_not_object');
    }
  });

  it('rejects data-URL without a comma (invalid_data_url)', () => {
    const body = makeBundleBody();
    body._embeddedAudio = { 'audio/tts_sp1.mp3': 'data:audio/mpeg;base64-no-comma' };
    try {
      parseEmbeddedBundle(body);
    } catch (e) {
      expect((e as BundleDecodeError).code).toBe('invalid_data_url');
    }
  });

  it('accepts keys with dots, dashes, underscores but rejects slashes', () => {
    const body = makeBundleBody();
    body._embeddedAudio = { 'audio/tts-sp.1_v2.mp3': FAKE_MP3_DATA_URL };
    (body.scenes[0]!.actions[0] as { audioRef?: string }).audioRef = 'audio/tts-sp.1_v2.mp3';
    expect(() => parseEmbeddedBundle(body)).not.toThrow();

    const body2 = makeBundleBody();
    body2._embeddedAudio = { 'audio/sub/dir.mp3': FAKE_MP3_DATA_URL };
    try {
      parseEmbeddedBundle(body2);
    } catch (e) {
      expect((e as BundleDecodeError).code).toBe('invalid_audio_key');
    }
  });
});
