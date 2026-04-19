import type { Scene } from '../../validation/classroom.js';
import {
  normalizeSceneTimeline,
  renderTimelineGateDom,
  TIMELINE_CSS,
  type TimelineEntry,
} from '../shared/timeline.js';

// Static HTML renderer for a single scene inside a SCORM 1.2 package. v1 fidelity
// was slides-only with a SCORM LMS shim (`runtime.js`) that reports session_time +
// lesson_status. α.3 adds a second script, `timeline.js`, which runs the
// action-timeline playback engine — it reads an inline <script type="application/json">
// block for the normalized per-scene timeline and drives audio auto-advance.
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

// See render-scene.ts — inline JSON escape so a `</script>` in caption text
// doesn't terminate the script element early.
function jsonForInlineScript(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c');
}

function speechEntriesFor(timeline: TimelineEntry[]): TimelineEntry[] {
  return timeline.filter((e) => e.type === 'speech' && e.text && e.text.trim().length > 0);
}

export interface RenderSlideOptions {
  title: string;            // scene title (or fallback)
  index: number;            // 0-based scene index
  total: number;            // total scene count
  prevHref: string | null;  // filename of previous slide, or null if first
  nextHref: string | null;  // filename of next slide, or null if last
  language: string;
  // In-ZIP paths of audio blobs that were actually bundled. The renderer
  // only emits `<audio>` tags for speech actions whose `audioRef` is a
  // member of this set — a missing-blob ref becomes a silent caption
  // rather than a broken 404 in the SCORM player.
  availableAudio?: Set<string>;
}

const SHARED_CSS = `
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; max-width: 900px; margin: 0 auto; padding: 2rem; color: #1a1a1a; line-height: 1.6; }
  .progress { font-size: 0.875rem; color: #6a6a6a; margin-bottom: 1rem; }
  h1 { font-size: 2rem; margin: 0 0 1.5rem; color: #0a0a0a; }
  .narration p { font-size: 1.125rem; margin: 0 0 1rem; }
  .narration audio { display: block; margin: 0 0 1.25rem; width: 100%; max-width: 540px; }
  nav.scorm-nav { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid #e0e0e0; display: flex; justify-content: space-between; gap: 1rem; }
  nav.scorm-nav a { padding: 0.5rem 1rem; background: #f3f3f3; border-radius: 4px; text-decoration: none; color: #1a1a1a; }
  nav.scorm-nav a[aria-disabled="true"] { visibility: hidden; }
  nav.scorm-nav a:hover { background: #e0e0e0; }
`;

export function renderSceneHtml(scene: Scene, opts: RenderSlideOptions): string {
  const title = escapeHtml(opts.title);
  const timeline = normalizeSceneTimeline(scene, opts.availableAudio);
  const speechEntries = speechEntriesFor(timeline);

  const narrationHtml = speechEntries.length > 0
    ? `<div class="narration">\n      ${speechEntries
        .map((e) => {
          const captionId = escapeHtml(e.captionElementId || '');
          const textP = `<p id="${captionId}">${escapeHtml(e.text || '')}</p>`;
          // No `controls` — the timeline runtime drives play/pause. Captions
          // remain readable if JS fails to load (e.g., LMS blocks timeline.js).
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

  // isLast is consumed by runtime.js to decide when to send lesson_status=completed.
  const isLast = opts.nextHref === null ? 'true' : 'false';

  // Script order matters: runtime.js (LMS shim) first so init() runs regardless of
  // timeline.js's state. Both are `defer`'d so the DOM is parsed before either fires.
  return `<!doctype html>
<html lang="${escapeHtml(opts.language)}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>${SHARED_CSS}${TIMELINE_CSS}</style>
  <script>window.__SCORM_SLIDE__ = { index: ${opts.index}, total: ${opts.total}, isLast: ${isLast} };</script>
  <script type="application/json" id="timeline">${jsonForInlineScript(timeline)}</script>
  <script src="runtime.js" defer></script>
  <script src="../timeline.js" defer></script>
</head>
<body>
  <p class="progress">Slide ${opts.index + 1} of ${opts.total}</p>
  <h1>${title}</h1>
  ${narrationHtml}
  <nav class="scorm-nav" aria-label="Slide navigation">
    ${prev}
    ${next}
  </nav>
  ${renderTimelineGateDom()}
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
