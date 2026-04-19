import type { Scene, SpeechAction } from '../../validation/classroom.js';

/*
 * NOTE: this file is duplicated byte-for-byte in services/ui/public/exporters/html.js
 * and services/ui/public/exporters/scorm1_2.js (the browser-side ports) via the
 * render-scene functions inlined there. A parity test
 * (tests/unit/exporter-parity.test.ts) cross-checks the two implementations.
 */
// Static HTML per-scene renderer for the stand-alone HTML export (no SCORM wrapper).
// Differs from the scorm1_2 renderer in three ways:
//   1. No `<script src="runtime.js">` — there's no LMS to talk to.
//   2. No `window.__SCORM_SLIDE__` injection.
//   3. Nav includes a "Back to contents" link to index.html, since the HTML TOC
//      is a real landing page (unlike the SCORM entry which auto-redirects).
//
// Styling is inlined per-file so each scene HTML is openable directly from disk
// (no broken href when a user extracts the ZIP and double-clicks a scene).

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function speechTextFor(scene: Scene): string[] {
  return (scene.actions ?? [])
    .filter((a): a is SpeechAction => a.type === 'speech' && typeof (a as SpeechAction).text === 'string')
    .map((a) => (a as SpeechAction).text)
    .filter((t) => t.trim().length > 0);
}

export interface RenderSceneOptions {
  title: string;
  index: number;           // 0-based
  total: number;
  prevHref: string | null; // relative to this file's dir; null if first
  nextHref: string | null;
  tocHref: string;         // relative path back to TOC ("../index.html" from scenes/*)
  language: string;
}

const SCENE_CSS = `
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; max-width: 900px; margin: 0 auto; padding: 2rem; color: #1a1a1a; line-height: 1.6; background: #fafafa; }
  .crumbs { font-size: 0.875rem; color: #6a6a6a; margin-bottom: 1rem; }
  .crumbs a { color: inherit; }
  h1 { font-size: 2rem; margin: 0 0 1.5rem; color: #0a0a0a; }
  .progress { font-size: 0.875rem; color: #6a6a6a; margin-bottom: 1rem; }
  .narration p { font-size: 1.125rem; margin: 0 0 1rem; }
  nav.slide-nav { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid #e0e0e0; display: flex; justify-content: space-between; gap: 1rem; }
  nav.slide-nav a { padding: 0.5rem 1rem; background: #f3f3f3; border-radius: 4px; text-decoration: none; color: #1a1a1a; border: 1px solid #e8e8e8; }
  nav.slide-nav a[aria-disabled="true"] { visibility: hidden; }
  nav.slide-nav a:hover { background: #ebebeb; }
`;

export function renderSceneHtml(scene: Scene, opts: RenderSceneOptions): string {
  const title = escapeHtml(opts.title);
  const speeches = speechTextFor(scene).map(escapeHtml);
  const narrationHtml =
    speeches.length > 0
      ? `<div class="narration">${speeches.map((t) => `<p>${t}</p>`).join('\n      ')}</div>`
      : `<div class="narration"><p><em>(This slide has no narration.)</em></p></div>`;

  const prev = opts.prevHref
    ? `<a href="${escapeHtml(opts.prevHref)}">&larr; Previous</a>`
    : `<a aria-disabled="true">&larr; Previous</a>`;
  const next = opts.nextHref
    ? `<a href="${escapeHtml(opts.nextHref)}">Next &rarr;</a>`
    : `<a aria-disabled="true">Next &rarr;</a>`;

  return `<!doctype html>
<html lang="${escapeHtml(opts.language)}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>${SCENE_CSS}</style>
</head>
<body>
  <p class="crumbs"><a href="${escapeHtml(opts.tocHref)}">&larr; Contents</a></p>
  <p class="progress">Slide ${opts.index + 1} of ${opts.total}</p>
  <h1>${title}</h1>
  ${narrationHtml}
  <nav class="slide-nav" aria-label="Slide navigation">
    ${prev}
    ${next}
  </nav>
</body>
</html>`;
}
