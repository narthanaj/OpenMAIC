import type { Scene, SpeechAction } from '../../validation/classroom.js';

// Static HTML renderer for a single scene. v1 fidelity is slides-only, so the output
// is deliberately simple: title, narration text (pulled from speech actions), and
// prev/next navigation links that the runtime.js shim wires up to LMS events.
//
// Styling is inlined rather than imported from a shared stylesheet so each slide
// is self-sufficient — in a SCORM package, any slide can be navigated to directly
// by the LMS, and we don't want the first slide to "own" the CSS.

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

export interface RenderSlideOptions {
  title: string;            // scene title (or fallback)
  index: number;            // 0-based scene index
  total: number;            // total scene count
  prevHref: string | null;  // filename of previous slide, or null if first
  nextHref: string | null;  // filename of next slide, or null if last
  language: string;
}

const SHARED_CSS = `
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; max-width: 900px; margin: 0 auto; padding: 2rem; color: #1a1a1a; line-height: 1.6; }
  .progress { font-size: 0.875rem; color: #6a6a6a; margin-bottom: 1rem; }
  h1 { font-size: 2rem; margin: 0 0 1.5rem; color: #0a0a0a; }
  .narration p { font-size: 1.125rem; margin: 0 0 1rem; }
  nav.scorm-nav { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid #e0e0e0; display: flex; justify-content: space-between; gap: 1rem; }
  nav.scorm-nav a { padding: 0.5rem 1rem; background: #f3f3f3; border-radius: 4px; text-decoration: none; color: #1a1a1a; }
  nav.scorm-nav a[aria-disabled="true"] { visibility: hidden; }
  nav.scorm-nav a:hover { background: #e0e0e0; }
`;

export function renderSceneHtml(scene: Scene, opts: RenderSlideOptions): string {
  const title = escapeHtml(opts.title);
  const speeches = speechTextFor(scene).map(escapeHtml);
  const narrationHtml = speeches.length > 0
    ? `<div class="narration">${speeches.map((t) => `<p>${t}</p>`).join('\n      ')}</div>`
    : `<div class="narration"><p><em>(This slide has no narration.)</em></p></div>`;

  const prev = opts.prevHref
    ? `<a href="${escapeHtml(opts.prevHref)}">&larr; Previous</a>`
    : `<a aria-disabled="true">&larr; Previous</a>`;
  const next = opts.nextHref
    ? `<a href="${escapeHtml(opts.nextHref)}">Next &rarr;</a>`
    : `<a aria-disabled="true">Next &rarr;</a>`;

  // isLast is consumed by runtime.js to decide when to send lesson_status=completed.
  const isLast = opts.nextHref === null ? 'true' : 'false';

  return `<!doctype html>
<html lang="${escapeHtml(opts.language)}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>${SHARED_CSS}</style>
  <script>window.__SCORM_SLIDE__ = { index: ${opts.index}, total: ${opts.total}, isLast: ${isLast} };</script>
  <script src="runtime.js" defer></script>
</head>
<body>
  <p class="progress">Slide ${opts.index + 1} of ${opts.total}</p>
  <h1>${title}</h1>
  ${narrationHtml}
  <nav class="scorm-nav" aria-label="Slide navigation">
    ${prev}
    ${next}
  </nav>
</body>
</html>`;
}

// Entry HTML — immediately redirects to scene 0. Kept separate from scene HTML so
// the SCORM manifest can declare a single launch point without any content-typed
// logic in the first scene's file.
export function renderEntryHtml(firstScene: string, language: string): string {
  return `<!doctype html>
<html lang="${escapeHtml(language)}">
<head>
  <meta charset="utf-8" />
  <title>Loading…</title>
  <meta http-equiv="refresh" content="0;url=${escapeHtml(firstScene)}" />
</head>
<body><p>Loading…</p></body>
</html>`;
}
