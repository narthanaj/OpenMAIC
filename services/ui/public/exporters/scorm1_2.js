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

function speechTexts(scene) {
  return (scene.actions ?? [])
    .filter((a) => a && a.type === 'speech' && typeof a.text === 'string')
    .map((a) => a.text)
    .filter((t) => t.trim().length > 0);
}

function renderSceneHtml(scene, opts) {
  const title = escapeHtml(opts.title);
  const speeches = speechTexts(scene).map(escapeHtml);
  const narrationHtml = speeches.length
    ? `<div class="narration">${speeches.map((t) => `<p>${t}</p>`).join('\n      ')}</div>`
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

function buildManifest(classroom, sceneHrefs, entryHref, runtimeHref) {
  const manifestId = `OpenMAIC-${classroom.id}`;
  const orgId = `ORG-${classroom.id}`;
  const entryResourceId = `RES-ENTRY-${classroom.id}`;
  const items = classroom.scenes
    .map((scene, i) => {
      const title = xmlEscape(scene.title ?? `Slide ${i + 1}`);
      return `      <item identifier="ITEM-${xmlEscape(scene.id)}" identifierref="${entryResourceId}">
        <title>${title}</title>
      </item>`;
    })
    .join('\n');
  const fileEntries = [entryHref, runtimeHref, ...sceneHrefs]
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
export function buildZipFiles(classroom, language) {
  const lang = language ?? classroom?.stage?.language ?? 'en';
  const scenes = [...classroom.scenes].sort((a, b) => a.order - b.order);
  const total = scenes.length;
  const sceneHrefs = scenes.map((_, i) => sceneHrefFor(i));

  const sceneFiles = scenes.map((scene, i) => ({
    path: sceneHrefs[i],
    content: renderSceneHtml(scene, {
      title: (scene.title && scene.title.trim()) || `Slide ${i + 1}`,
      index: i,
      total,
      prevHref: i > 0 ? String(i).padStart(3, '0') + '.html' : null,
      nextHref: i < total - 1 ? String(i + 2).padStart(3, '0') + '.html' : null,
      language: lang,
    }),
  }));

  const manifest = buildManifest(classroom, sceneHrefs, 'index.html', 'runtime.js');
  const entry = renderEntryHtml(sceneHrefs[0], lang);

  return [
    { path: 'imsmanifest.xml', content: manifest },
    { path: 'index.html', content: entry },
    { path: 'runtime.js', content: SCORM_RUNTIME_JS },
    ...sceneFiles,
  ];
}

/**
 * Produce a Blob (browser) of the SCORM 1.2 package for `classroom`.
 * Callers trigger a download by using URL.createObjectURL on the returned Blob.
 */
export async function buildZipBlob(classroom, language) {
  const JSZip = globalThis.JSZip;
  if (!JSZip) throw new Error('JSZip is not loaded — check that vendor/jszip.min.js is reachable');
  const zip = new JSZip();
  for (const f of buildZipFiles(classroom, language)) {
    zip.file(f.path, f.content);
  }
  return zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}
