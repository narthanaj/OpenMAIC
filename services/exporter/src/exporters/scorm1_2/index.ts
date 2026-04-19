import type { Readable } from 'node:stream';
import type { ContentExporter, ExportOptions } from '../types.js';
import type { Classroom } from '../../validation/classroom.js';
import { renderSceneHtml, renderEntryHtml } from './render-slide.js';
import { SCORM_RUNTIME_JS } from './runtime.js';
import { buildManifest, manifestFilename } from './manifest.js';
import { buildExportZipStream, type ZipFile } from '../shared/zip.js';
import { TIMELINE_RUNTIME_JS } from '../shared/timeline.js';

// SCORM 1.2 exporter — orchestrates manifest + runtime + per-scene HTML rendering
// and returns a streaming ZIP. α.3 adds timeline.js (action-timeline playback
// engine) alongside the existing runtime.js (SCORM LMS shim).

const ENTRY_HREF = 'index.html';
const RUNTIME_HREF = 'runtime.js';
const TIMELINE_HREF = 'timeline.js';

function sceneHrefFor(index: number): string {
  // 1-based + zero-padded so shell tooling (ls, unzip -l) sorts them naturally.
  const padded = String(index + 1).padStart(3, '0');
  return `scenes/${padded}.html`;
}

function buildZipFiles(
  classroom: Classroom,
  language: string,
  mediaBundle?: Map<string, Buffer>,
): ZipFile[] {
  const scenes = [...classroom.scenes].sort((a, b) => a.order - b.order);
  const total = scenes.length;
  const sceneHrefs = scenes.map((_, i) => sceneHrefFor(i));

  // Set of audio paths actually present in the bundle. Renderer uses this to
  // decide whether to emit an `<audio>` tag — a speech action whose audioRef
  // points at a blob we don't have would otherwise 404 in the LMS player.
  const availableAudio = new Set<string>();
  if (mediaBundle) {
    for (const path of mediaBundle.keys()) {
      if (path.startsWith('audio/')) availableAudio.add(path);
    }
  }

  const sceneFiles: ZipFile[] = scenes.map((scene, i) => ({
    path: sceneHrefs[i]!,
    // Scene HTML compresses well (template boilerplate + repeating tags),
    // so DEFLATE is explicitly right here.
    compression: 'DEFLATE',
    content: renderSceneHtml(scene, {
      title: scene.title?.trim() || `Slide ${i + 1}`,
      index: i,
      total,
      // prev/next are RELATIVE to the current scene file — they share the same
      // scenes/ subdir, so plain filenames work.
      prevHref: i > 0 ? String(i).padStart(3, '0') + '.html' : null,
      nextHref: i < total - 1 ? String(i + 2).padStart(3, '0') + '.html' : null,
      language,
      availableAudio,
    }),
  }));

  // Audio entries — STORE (no compression). MP3/AAC/WAV are either already
  // compressed or not worth re-compressing: DEFLATE wastes CPU for ~0% gain
  // and occasionally inflates the output by header overhead.
  const audioFiles: ZipFile[] = [];
  if (mediaBundle) {
    for (const [path, buf] of mediaBundle) {
      // The route's key regex already validated these paths structurally;
      // this filter is just the audio-vs-media split for compression choice.
      // (media/* goes through the same STORE path — images are compressed too.)
      audioFiles.push({ path, content: buf, compression: 'STORE' });
    }
  }

  const manifest = buildManifest({
    classroom,
    entryHref: ENTRY_HREF,
    sceneHrefs,
    runtimeHref: RUNTIME_HREF,
    timelineHref: TIMELINE_HREF,
    language,
    mediaPaths: [...availableAudio, ...[...(mediaBundle?.keys() ?? [])].filter((p) => p.startsWith('media/'))],
  });

  // Entry file redirects to the first scene. Using it as a thin launcher keeps
  // manifest logic simple (single resource pointing at index.html) and gives us
  // a natural place to bolt on an LMS-facing welcome screen later if we want.
  const entry = renderEntryHtml(sceneHrefs[0]!, language);

  return [
    { path: manifestFilename(), content: manifest, compression: 'DEFLATE' },
    { path: ENTRY_HREF, content: entry, compression: 'DEFLATE' },
    { path: RUNTIME_HREF, content: SCORM_RUNTIME_JS, compression: 'DEFLATE' },
    { path: TIMELINE_HREF, content: TIMELINE_RUNTIME_JS, compression: 'DEFLATE' },
    ...sceneFiles,
    ...audioFiles,
  ];
}

async function exportScorm12(classroom: Classroom, opts?: ExportOptions): Promise<Readable> {
  const language = opts?.language ?? classroom.stage.language ?? 'en';
  const files = buildZipFiles(classroom, language, opts?.mediaBundle);
  return buildExportZipStream(files);
}

export const scormV1_2Exporter: ContentExporter = {
  id: 'scorm1.2',
  name: 'SCORM 1.2',
  export: exportScorm12,
};

// Re-exports for tests (they want to drive the internal pieces without spinning
// the whole HTTP server).
export { buildZipFiles };
