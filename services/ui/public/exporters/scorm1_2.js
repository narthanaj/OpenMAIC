// Browser-side SCORM 1.2 exporter. Port of services/exporter/src/exporters/scorm1_2/*.ts.
// Deliberate duplication — see feedback memory. A parity test in the backend repo
// guards against drift between this JS and the TypeScript original by cross-checking
// unpacked ZIP contents from both implementations.
//
// This module MUST stay browser-safe: no Buffer, no node:* imports, no DOM. It is
// imported dynamically by app.js for UI use AND directly by the Node-based parity
// test via ESM (vanilla ES modules run in both environments).
//
// JSZip is a peer dependency loaded via a <script> tag in index.html; we reference
// it as `globalThis.JSZip` to avoid hard-coding `window.` (Node parity-test has no window).

import {
  normalizeSceneTimeline,
  renderTimelineGateDom,
  TIMELINE_CSS,
  TIMELINE_RUNTIME_JS,
} from './shared-timeline.js';

// ---- Inline SCORM 1.2 runtime shim (lands as runtime.js inside the ZIP). ----
// MUST stay byte-for-byte identical to the backend's scorm1_2/runtime.ts export.
// The parity test enforces this; any change here must land on the backend too.
export const SCORM_RUNTIME_JS = `/* OpenMAIC SCORM 1.2 runtime shim (v0.1.0) */
(function () {
  'use strict';

  // Walk up parent windows looking for the LMS API. The SCORM 1.2 CAM spec says the
  // API finder should traverse window.parent up to 7 levels, then window.opener. In
  // practice most LMSs expose it on the immediate parent; we cap at 10 for safety.
  function findAPI(win) {
    var tries = 0;
    while (win && !win.API && win.parent && win.parent !== win && tries < 10) {
      win = win.parent;
      tries++;
    }
    return win ? win.API || null : null;
  }

  var api = findAPI(window);
  if (!api && window.opener) api = findAPI(window.opener);

  var enteredAt = Date.now();
  var slide = window.__SCORM_SLIDE__ || { index: 0, total: 1, isLast: true };
  var initialized = false;

  function init() {
    if (!api) return;
    try {
      var ok = api.LMSInitialize('');
      initialized = ok === 'true' || ok === true;
      if (initialized) {
        api.LMSSetValue('cmi.core.lesson_status', 'incomplete');
      }
    } catch (e) { /* swallow — non-LMS preview */ }
  }

  function secondsToScormTime(secs) {
    // CMITimespan: HHHH:MM:SS.SS
    var h = Math.floor(secs / 3600);
    var m = Math.floor((secs % 3600) / 60);
    var s = (secs % 60).toFixed(2);
    return String(h).padStart(4, '0') + ':' + String(m).padStart(2, '0') + ':' + (s.length === 4 ? '0' + s : s);
  }

  function finish(status) {
    if (!api || !initialized) return;
    try {
      var elapsed = (Date.now() - enteredAt) / 1000;
      api.LMSSetValue('cmi.core.session_time', secondsToScormTime(elapsed));
      if (status) api.LMSSetValue('cmi.core.lesson_status', status);
      api.LMSCommit('');
      api.LMSFinish('');
    } catch (e) { /* swallow */ }
  }

  // Wire up.
  init();

  // Last slide → mark completed. We commit but don't finish yet — the LMS picks up
  // the "completed" status on the next Commit, and Finish will still fire on unload.
  if (slide.isLast && api && initialized) {
    try {
      api.LMSSetValue('cmi.core.lesson_status', 'completed');
      api.LMSCommit('');
    } catch (e) { /* swallow */ }
  }

  // Unload hook — make sure the LMS sees a clean session close.
  window.addEventListener('beforeunload', function () { finish(null); });
  window.addEventListener('pagehide', function () { finish(null); });
})();
`;

// ---- Helpers ----

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function jsonForInlineScript(v) {
  return JSON.stringify(v).replace(/</g, '\\u003c');
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

function speechEntriesFor(timeline) {
  return timeline.filter((e) => e && e.type === 'speech' && e.text && e.text.trim().length > 0);
}

function renderSceneHtml(scene, opts) {
  const title = escapeHtml(opts.title);
  const timeline = normalizeSceneTimeline(scene, opts.availableAudio);
  const speechEntries = speechEntriesFor(timeline);
  const narrationHtml = speechEntries.length
    ? `<div class="narration">\n      ${speechEntries
        .map((e) => {
          const captionId = escapeHtml(e.captionElementId || '');
          const textP = `<p id="${captionId}">${escapeHtml(e.text || '')}</p>`;
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
  const isLast = opts.nextHref === null ? 'true' : 'false';
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

function renderEntryHtml(firstScene, language) {
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

function buildManifest(classroom, sceneHrefs, entryHref, runtimeHref, timelineHref, mediaPaths) {
  // Mirror of backend manifest.ts — ids may be absent when the source is a
  // ClassroomManifest (id-stripped). Mint deterministic fallbacks.
  const classroomId = classroom.id ?? 'unnamed';
  const manifestId = `OpenMAIC-${xmlEscape(classroomId)}`;
  const orgId = `ORG-${xmlEscape(classroomId)}`;
  const entryResourceId = `RES-ENTRY-${xmlEscape(classroomId)}`;
  const items = classroom.scenes
    .map((scene, i) => {
      const title = xmlEscape(scene.title ?? `Slide ${i + 1}`);
      const itemId = scene.id ?? `scene-${i + 1}`;
      return `      <item identifier="ITEM-${xmlEscape(itemId)}" identifierref="${entryResourceId}">
        <title>${title}</title>
      </item>`;
    })
    .join('\n');
  const allFiles = [entryHref, runtimeHref];
  if (timelineHref) allFiles.push(timelineHref);
  allFiles.push(...sceneHrefs, ...(mediaPaths ?? []));
  const fileEntries = allFiles
    .map((href) => `      <file href="${xmlEscape(href)}"/>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="${manifestId}" version="1.2"
          xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
          xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
          xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd
                              http://www.imsglobal.org/xsd/imsmd_rootv1p2p1 imsmd_rootv1p2p1.xsd
                              http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="${orgId}">
    <organization identifier="${orgId}">
      <title>${xmlEscape(classroom.stage.name)}</title>
${items}
    </organization>
  </organizations>
  <resources>
    <resource identifier="${entryResourceId}" type="webcontent"
              adlcp:scormtype="sco" href="${xmlEscape(entryHref)}">
${fileEntries}
    </resource>
  </resources>
</manifest>
`;
}

function sceneHrefFor(index) {
  return `scenes/${String(index + 1).padStart(3, '0')}.html`;
}

// ---- Public API ----

/**
 * Build an ordered list of { path, content } entries for the SCORM ZIP.
 * Exposed separately from buildZipBlob so the parity test can diff entry-by-entry
 * with the backend's equivalent `buildZipFiles` output.
 */
export function buildZipFiles(classroom, language, mediaBundle) {
  const lang = language ?? classroom?.stage?.language ?? 'en';
  const scenes = [...classroom.scenes].sort((a, b) => a.order - b.order);
  const total = scenes.length;
  const sceneHrefs = scenes.map((_, i) => sceneHrefFor(i));

  const availableAudio = new Set();
  if (mediaBundle) {
    for (const path of mediaBundle.keys()) {
      if (path.startsWith('audio/')) availableAudio.add(path);
    }
  }

  const sceneFiles = scenes.map((scene, i) => ({
    path: sceneHrefs[i],
    compression: 'DEFLATE',
    content: renderSceneHtml(scene, {
      title: (scene.title && scene.title.trim()) || `Slide ${i + 1}`,
      index: i,
      total,
      prevHref: i > 0 ? String(i).padStart(3, '0') + '.html' : null,
      nextHref: i < total - 1 ? String(i + 2).padStart(3, '0') + '.html' : null,
      language: lang,
      availableAudio,
    }),
  }));

  const mediaFiles = [];
  const mediaPaths = [];
  if (mediaBundle) {
    for (const [path, buf] of mediaBundle) {
      mediaFiles.push({ path, content: buf, compression: 'STORE' });
      mediaPaths.push(path);
    }
  }

  const manifest = buildManifest(classroom, sceneHrefs, 'index.html', 'runtime.js', 'timeline.js', mediaPaths);
  const entry = renderEntryHtml(sceneHrefs[0], lang);

  return [
    { path: 'imsmanifest.xml', compression: 'DEFLATE', content: manifest },
    { path: 'index.html', compression: 'DEFLATE', content: entry },
    { path: 'runtime.js', compression: 'DEFLATE', content: SCORM_RUNTIME_JS },
    { path: 'timeline.js', compression: 'DEFLATE', content: TIMELINE_RUNTIME_JS },
    ...sceneFiles,
    ...mediaFiles,
  ];
}

/**
 * Produce a Blob (browser) of the SCORM 1.2 package for `classroom`.
 * Callers trigger a download by using URL.createObjectURL on the returned Blob.
 */
export async function buildZipBlob(classroom, language, mediaBundle) {
  const JSZip = globalThis.JSZip;
  if (!JSZip) throw new Error('JSZip is not loaded — check that vendor/jszip.min.js is reachable');
  const zip = new JSZip();
  for (const f of buildZipFiles(classroom, language, mediaBundle)) {
    const opts = f.compression
      ? { compression: f.compression, compressionOptions: f.compression === 'DEFLATE' ? { level: 6 } : undefined }
      : undefined;
    zip.file(f.path, f.content, opts);
  }
  return zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}
