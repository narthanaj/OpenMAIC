import type { Readable } from 'node:stream';
import type { ContentExporter, ExportOptions } from '../types.js';
import type { Classroom } from '../../validation/classroom.js';
import { renderSceneHtml, renderEntryHtml } from './render-slide.js';
import { SCORM_RUNTIME_JS } from './runtime.js';
import { buildManifest, manifestFilename } from './manifest.js';
import { buildExportZipStream, type ZipFile } from '../shared/zip.js';

// SCORM 1.2 exporter — orchestrates manifest + runtime + per-scene HTML rendering
// and returns a streaming ZIP. v1 is slides-only; audio, quiz score reporting, and
// discussion transcripts land in v2+ (see README Roadmap).

const ENTRY_HREF = 'index.html';
const RUNTIME_HREF = 'runtime.js';

function sceneHrefFor(index: number): string {
  // 1-based + zero-padded so shell tooling (ls, unzip -l) sorts them naturally.
  const padded = String(index + 1).padStart(3, '0');
  return `scenes/${padded}.html`;
}

function buildZipFiles(classroom: Classroom, language: string): ZipFile[] {
  const scenes = [...classroom.scenes].sort((a, b) => a.order - b.order);
  const total = scenes.length;
  const sceneHrefs = scenes.map((_, i) => sceneHrefFor(i));

  const sceneFiles: ZipFile[] = scenes.map((scene, i) => ({
    path: sceneHrefs[i]!,
    content: renderSceneHtml(scene, {
      title: scene.title?.trim() || `Slide ${i + 1}`,
      index: i,
      total,
      // prev/next are RELATIVE to the current scene file — they share the same
      // scenes/ subdir, so plain filenames work.
      prevHref: i > 0 ? String(i).padStart(3, '0') + '.html' : null,
      nextHref: i < total - 1 ? String(i + 2).padStart(3, '0') + '.html' : null,
      language,
    }),
  }));

  const manifest = buildManifest({
    classroom,
    entryHref: ENTRY_HREF,
    sceneHrefs,
    runtimeHref: RUNTIME_HREF,
    language,
  });

  // Entry file redirects to the first scene. Using it as a thin launcher keeps
  // manifest logic simple (single resource pointing at index.html) and gives us
  // a natural place to bolt on an LMS-facing welcome screen later if we want.
  const entry = renderEntryHtml(sceneHrefs[0]!, language);

  return [
    { path: manifestFilename(), content: manifest },
    { path: ENTRY_HREF, content: entry },
    { path: RUNTIME_HREF, content: SCORM_RUNTIME_JS },
    ...sceneFiles,
  ];
}

async function exportScorm12(classroom: Classroom, opts?: ExportOptions): Promise<Readable> {
  const language = opts?.language ?? classroom.stage.language ?? 'en';
  const files = buildZipFiles(classroom, language);
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
