// Browser-side static-HTML exporter. Port of services/exporter/src/exporters/html/*.ts.
// Same rules as the SCORM port: browser-safe, no Node APIs, no DOM. Parity test
// cross-checks against the backend TypeScript implementation.

import {
  normalizeSceneTimeline,
  renderTimelineGateDom,
  TIMELINE_CSS,
  TIMELINE_RUNTIME_JS,
} from './shared-timeline.js';

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Inline <script type="application/json"> blocks can be closed by `</script>`
// appearing in caption text. Escape `<` as \u003c to keep the block valid.
function jsonForInlineScript(v) {
  return JSON.stringify(v).replace(/</g, '\\u003c');
}

function speechEntriesFor(timeline) {
  return timeline.filter((e) => e && e.type === 'speech' && e.text && e.text.trim().length > 0);
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

const TOC_CSS = `
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; max-width: 900px; margin: 0 auto; padding: 2rem; color: #1a1a1a; line-height: 1.6; background: #fafafa; }
  h1 { font-size: 2.25rem; margin: 0 0 0.5rem; color: #0a0a0a; }
  .subtitle { font-size: 1rem; color: #6a6a6a; margin: 0 0 2rem; }
  .meta { font-size: 0.875rem; color: #6a6a6a; margin-bottom: 2rem; padding: 0.75rem 1rem; background: #f3f3f3; border-radius: 6px; display: inline-block; }
  ol.scene-list { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: 1fr; gap: 0.75rem; }
  ol.scene-list li { margin: 0; }
  ol.scene-list a { display: flex; align-items: baseline; gap: 0.75rem; padding: 1rem 1.25rem; background: #fff; border: 1px solid #e8e8e8; border-radius: 8px; text-decoration: none; color: #1a1a1a; transition: border-color 0.15s; }
  ol.scene-list a:hover { border-color: #b4b4b4; background: #fff; }
  ol.scene-list .num { font-variant-numeric: tabular-nums; color: #9a9a9a; font-size: 0.875rem; min-width: 2.25rem; }
  ol.scene-list .title { font-weight: 500; }
  footer { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid #e0e0e0; font-size: 0.75rem; color: #9a9a9a; }
`;

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

function renderTocHtml(classroom, sceneHrefs, language) {
  const scenes = [...classroom.scenes].sort((a, b) => a.order - b.order);
  const description = classroom.stage.description
    ? `<p class="subtitle">${escapeHtml(classroom.stage.description)}</p>`
    : '';
  const items = scenes
    .map((scene, i) => {
      const title = escapeHtml((scene.title && scene.title.trim()) || `Slide ${i + 1}`);
      const href = escapeHtml(sceneHrefs[i]);
      const num = String(i + 1).padStart(2, '0');
      return `    <li><a href="${href}"><span class="num">${num}</span><span class="title">${title}</span></a></li>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="${escapeHtml(language)}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(classroom.stage.name)}</title>
  <style>${TOC_CSS}</style>
</head>
<body>
  <h1>${escapeHtml(classroom.stage.name)}</h1>
  ${description}
  <p class="meta">${scenes.length} slide${scenes.length === 1 ? '' : 's'}</p>
  <ol class="scene-list">
${items}
  </ol>
  <footer>Generated by OpenMAIC exporter &middot; classroom id: ${escapeHtml(classroom.id ?? 'unnamed')}</footer>
</body>
</html>`;
}

function sceneHrefFor(index) {
  return `scenes/${String(index + 1).padStart(3, '0')}.html`;
}

// ---- Public API ----

export function buildZipFiles(classroom, language, mediaBundle) {
  const lang = language ?? classroom?.stage?.language ?? 'en';
  const scenes = [...classroom.scenes].sort((a, b) => a.order - b.order);
  const total = scenes.length;
  const sceneHrefs = scenes.map((_, i) => sceneHrefFor(i));
  const TOC_HREF = 'index.html';
  const TIMELINE_HREF = 'timeline.js';

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
      tocHref: '../' + TOC_HREF,
      language: lang,
      availableAudio,
    }),
  }));

  const mediaFiles = [];
  if (mediaBundle) {
    for (const [path, buf] of mediaBundle) {
      mediaFiles.push({ path, content: buf, compression: 'STORE' });
    }
  }

  return [
    { path: TOC_HREF, compression: 'DEFLATE', content: renderTocHtml(classroom, sceneHrefs, lang) },
    { path: TIMELINE_HREF, compression: 'DEFLATE', content: TIMELINE_RUNTIME_JS },
    ...sceneFiles,
    ...mediaFiles,
  ];
}

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
