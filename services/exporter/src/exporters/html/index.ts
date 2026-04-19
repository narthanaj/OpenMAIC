import type { Readable } from 'node:stream';
import type { ContentExporter, ExportOptions } from '../types.js';
import type { Classroom } from '../../validation/classroom.js';
import { renderSceneHtml } from './render-scene.js';
import { renderTocHtml } from './render-toc.js';
import { buildExportZipStream, type ZipFile } from '../shared/zip.js';
import { TIMELINE_RUNTIME_JS } from '../shared/timeline.js';

// Static HTML export — a self-contained folder the user can extract and open
// directly in a browser, or deploy to any static host (GitHub Pages, S3 static
// website, Netlify, nginx, etc.). No LMS integration; all styling inlined per
// file so each page works stand-alone.
//
// α.3 adds timeline.js — a small vanilla-JS playback engine bundled at the
// ZIP root. Scene HTMLs reference it via `../timeline.js` and use an inline
// <script type="application/json" id="timeline"> block to drive playback.

const TOC_HREF = 'index.html';
const TIMELINE_HREF = 'timeline.js';

function sceneHrefFor(index: number): string {
  return `scenes/${String(index + 1).padStart(3, '0')}.html`;
}

function buildZipFiles(
  classroom: Classroom,
  language: string,
  mediaBundle?: Map<string, Buffer>,
): ZipFile[] {
  const scenes = [...classroom.scenes].sort((a, b) => a.order - b.order);
  const total = scenes.length;
  // Paths inside the ZIP, relative to ZIP root.
  const sceneHrefs = scenes.map((_, i) => sceneHrefFor(i));

  const availableAudio = new Set<string>();
  if (mediaBundle) {
    for (const path of mediaBundle.keys()) {
      if (path.startsWith('audio/')) availableAudio.add(path);
    }
  }

  // TOC references scene paths from the root; scenes reference each other by
  // plain basename (they share scenes/ dir) and the TOC via "../index.html".
  const sceneFiles: ZipFile[] = scenes.map((scene, i) => ({
    path: sceneHrefs[i]!,
    compression: 'DEFLATE',
    content: renderSceneHtml(scene, {
      title: scene.title?.trim() || `Slide ${i + 1}`,
      index: i,
      total,
      prevHref: i > 0 ? String(i).padStart(3, '0') + '.html' : null,
      nextHref: i < total - 1 ? String(i + 2).padStart(3, '0') + '.html' : null,
      tocHref: '../' + TOC_HREF,
      language,
      availableAudio,
    }),
  }));

  const toc: ZipFile = {
    path: TOC_HREF,
    compression: 'DEFLATE',
    content: renderTocHtml({ classroom, sceneHrefs, language }),
  };

  const timeline: ZipFile = {
    path: TIMELINE_HREF,
    compression: 'DEFLATE',
    content: TIMELINE_RUNTIME_JS,
  };

  const mediaFiles: ZipFile[] = [];
  if (mediaBundle) {
    for (const [path, buf] of mediaBundle) {
      mediaFiles.push({ path, content: buf, compression: 'STORE' });
    }
  }

  return [toc, timeline, ...sceneFiles, ...mediaFiles];
}

async function exportHtml(classroom: Classroom, opts?: ExportOptions): Promise<Readable> {
  const language = opts?.language ?? classroom.stage.language ?? 'en';
  return buildExportZipStream(buildZipFiles(classroom, language, opts?.mediaBundle));
}

export const htmlExporter: ContentExporter = {
  id: 'html',
  name: 'Static HTML',
  export: exportHtml,
};

// Exported for tests.
export { buildZipFiles };
