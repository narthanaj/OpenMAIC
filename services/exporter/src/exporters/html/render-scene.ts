import type { Scene } from '../../validation/classroom.js';
import {
  normalizeSceneTimeline,
  renderTimelineGateDom,
  TIMELINE_CSS,
  type TimelineEntry,
} from '../shared/timeline.js';

/*
 * NOTE: this file is duplicated byte-for-byte in services/ui/public/exporters/html.js
 * (the browser-side port) via the render-scene function inlined there. A parity test
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
//
// α.3 adds the timeline runtime: normalized action timeline inline as JSON,
// `<script src="timeline.js" defer>` loads the playback engine, and a gate
// overlay ensures the first audio.play() happens after a user gesture so
// browser autoplay policies don't silently block advancement.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Inline <script type="application/json"> blocks are parsed as JSON, not HTML,
// but the browser still scans the raw bytes for `</script>` to terminate the
// element. Escape `<` as `\u003c` to make closing tags in caption text safe.
function jsonForInlineScript(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c');
}

function speechEntriesFor(timeline: TimelineEntry[]): TimelineEntry[] {
  return timeline.filter((e) => e.type === 'speech' && e.text && e.text.trim().length > 0);
}

export interface RenderSceneOptions {
  title: string;
  index: number;           // 0-based
  total: number;
  prevHref: string | null; // relative to this file's dir; null if first
  nextHref: string | null;
  tocHref: string;         // relative path back to TOC ("../index.html" from scenes/*)
  language: string;
  // See the SCORM renderer's note: only bundled audio refs get `<audio>`
  // tags — missing refs render as silent captions.
  availableAudio?: Set<string>;
}

const SCENE_CSS = `
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; max-width: 900px; margin: 0 auto; padding: 2rem; color: #1a1a1a; line-height: 1.6; background: #fafafa; }
  .crumbs { font-size: 0.875rem; color: #6a6a6a; margin-bottom: 1rem; }
  .crumbs a { color: inherit; }
  h1 { font-size: 2rem; margin: 0 0 1.5rem; color: #0a0a0a; }
  .progress { font-size: 0.875rem; color: #6a6a6a; margin-bottom: 1rem; }
  .narration p { font-size: 1.125rem; margin: 0 0 1rem; }
  .narration audio { display: block; margin: 0 0 1.25rem; width: 100%; max-width: 540px; }
  nav.slide-nav { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid #e0e0e0; display: flex; justify-content: space-between; gap: 1rem; }
  nav.slide-nav a { padding: 0.5rem 1rem; background: #f3f3f3; border-radius: 4px; text-decoration: none; color: #1a1a1a; border: 1px solid #e8e8e8; }
  nav.slide-nav a[aria-disabled="true"] { visibility: hidden; }
  nav.slide-nav a:hover { background: #ebebeb; }
`;

export function renderSceneHtml(scene: Scene, opts: RenderSceneOptions): string {
  const title = escapeHtml(opts.title);
  const timeline = normalizeSceneTimeline(scene, opts.availableAudio);
  const speechEntries = speechEntriesFor(timeline);

  const narrationHtml = speechEntries.length > 0
    ? `<div class="narration">\n      ${speechEntries
        .map((e) => {
          const captionId = escapeHtml(e.captionElementId || '');
          const textP = `<p id="${captionId}">${escapeHtml(e.text || '')}</p>`;
          // <audio> has no `controls` — the timeline runtime drives play/pause.
          // If JS is disabled the captions still read as plain text.
          const audio = e.audio && e.audioElementId
            ? `\n        <audio id="${escapeHtml(e.audioElementId)}" preload="metadata" src="${escapeHtml(e.audio)}"></audio>`
            : '';
          return `${textP}${audio}`;
        })
        .join('\n      ')}\n    </div>`
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
  <style>${SCENE_CSS}${TIMELINE_CSS}</style>
  <script type="application/json" id="timeline">${jsonForInlineScript(timeline)}</script>
  <script src="../timeline.js" defer></script>
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
  ${renderTimelineGateDom()}
</body>
</html>`;
}
