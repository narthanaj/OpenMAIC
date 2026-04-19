import type { Readable } from 'node:stream';
import type { ContentExporter, ExportOptions } from '../types.js';
import type { Classroom } from '../../validation/classroom.js';
import { renderSceneHtml } from './render-scene.js';
import { renderTocHtml } from './render-toc.js';
import { buildExportZipStream, type ZipFile } from '../shared/zip.js';

// Static HTML export — a self-contained folder the user can extract and open
// directly in a browser, or deploy to any static host (GitHub Pages, S3 static
// website, Netlify, nginx, etc.). No LMS integration; no JavaScript at runtime;
// all styling inlined per file so each page works stand-alone.

const TOC_HREF = 'index.html';

function sceneHrefFor(index: number): string {
  return `scenes/${String(index + 1).padStart(3, '0')}.html`;
}

function buildZipFiles(classroom: Classroom, language: string): ZipFile[] {
  const scenes = [...classroom.scenes].sort((a, b) => a.order - b.order);
  const total = scenes.length;
  // Paths inside the ZIP, relative to ZIP root.
  const sceneHrefs = scenes.map((_, i) => sceneHrefFor(i));

  // TOC references scene paths from the root; scenes reference each other by
  // plain basename (they share scenes/ dir) and the TOC via "../index.html".
  const sceneFiles: ZipFile[] = scenes.map((scene, i) => ({
    path: sceneHrefs[i]!,
    content: renderSceneHtml(scene, {
      title: scene.title?.trim() || `Slide ${i + 1}`,
      index: i,
      total,
      prevHref: i > 0 ? String(i).padStart(3, '0') + '.html' : null,
      nextHref: i < total - 1 ? String(i + 2).padStart(3, '0') + '.html' : null,
      tocHref: '../' + TOC_HREF,
      language,
    }),
  }));

  const toc: ZipFile = {
    path: TOC_HREF,
    content: renderTocHtml({ classroom, sceneHrefs, language }),
  };

  return [toc, ...sceneFiles];
}

async function exportHtml(classroom: Classroom, opts?: ExportOptions): Promise<Readable> {
  const language = opts?.language ?? classroom.stage.language ?? 'en';
  return buildExportZipStream(buildZipFiles(classroom, language));
}

export const htmlExporter: ContentExporter = {
  id: 'html',
  name: 'Static HTML',
  export: exportHtml,
};

// Exported for tests.
export { buildZipFiles };
