// Converts OpenMAIC classroom exports into the shape our exporter consumes.
//
// Two entry points for two transports:
//   - parseMaicZip(file)          — canonical .maic.zip bundle (ClassroomManifest
//                                    + audio/ + media/). Produced by OpenMAIC's
//                                    "Export Classroom ZIP" button (v0.1.1). See
//                                    lib/export/classroom-zip-types.ts.
//   - parseEmbeddedJson(jsonText) — single .classroom.json produced by the
//                                    DevTools console snippet. Same manifest shape
//                                    as above, plus `_embeddedAudio` and
//                                    `_embeddedMedia` fields holding base64
//                                    data-URLs. Used when OpenMAIC's UI export
//                                    button isn't reachable in the user's build.
//
// Both return `{ classroom, bundle }`:
//   - classroom: ClassroomSchema-compatible, with synthetic ids minted from
//     exportedAt + scene.order for stable-across-runs identity.
//   - bundle: `{ audio: {zipPath → Blob}, media: {zipPath → Blob} }` — the α.2
//     exporter reads this when bundling audio into the SCORM ZIP.

// ---- Shared helpers ----

function slugify(s) {
  return (s || 'classroom')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 32) || 'classroom';
}

function languageFromDirective(dir) {
  const d = (dir || '').toLowerCase();
  if (/zh-?cn|chinese/.test(d)) return 'zh-CN';
  if (/ja-?jp|japanese/.test(d)) return 'ja-JP';
  if (/ru-?ru|russian/.test(d)) return 'ru-RU';
  return 'en';
}

/**
 * Transform an OpenMAIC ClassroomManifest (id-stripped) into our Classroom
 * (id-synthesized). Pure function — no blob handling, no I/O. Callers wire
 * the `bundle` separately from their own source.
 */
export function manifestToClassroom(manifest) {
  if (typeof manifest.formatVersion !== 'number') {
    throw new Error('manifest missing formatVersion — not an OpenMAIC export');
  }
  if (manifest.formatVersion > 1) {
    console.warn(
      `manifest formatVersion=${manifest.formatVersion} is newer than this UI supports (1); extra fields ignored`,
    );
  }
  if (!manifest.stage?.name) throw new Error('manifest missing stage.name');
  if (!Array.isArray(manifest.scenes) || manifest.scenes.length === 0) {
    throw new Error('manifest has no scenes');
  }

  const exportedAtMs = manifest.exportedAt ? new Date(manifest.exportedAt).getTime() : Date.now();
  const stageSlug = slugify(manifest.stage.name);
  const classroomId = `${stageSlug}-${exportedAtMs.toString(36)}`;

  const scenes = [...manifest.scenes]
    .sort((a, b) => a.order - b.order)
    .map((s, i) => ({
      id: `${classroomId}-scene-${String(i + 1).padStart(3, '0')}`,
      order: s.order,
      title: s.title,
      actions: Array.isArray(s.actions) ? s.actions : [],
      type: s.type,
      content: s.content,
      whiteboards: s.whiteboards,
      multiAgent: s.multiAgent,
    }));

  return {
    id: classroomId,
    stage: {
      id: `${classroomId}-stage`,
      name: manifest.stage.name,
      description: manifest.stage.description,
      language: languageFromDirective(manifest.stage.language),
      style: manifest.stage.style,
    },
    scenes,
    agents: manifest.agents ?? [],
    mediaIndex: manifest.mediaIndex ?? {},
    formatVersion: manifest.formatVersion,
    exportedAt: manifest.exportedAt,
    appVersion: manifest.appVersion,
  };
}

// ---- Entry point #1: .maic.zip bundle ----

/**
 * Parse a `.maic.zip` bundle. Tolerates two edge-case layouts:
 *   - `manifest.json` nested one level under a single top-level folder (user
 *     accidentally compressed the folder rather than selecting the files
 *     inside). Prefix is auto-stripped.
 *   - Underscore-flat file names (`audio_xxx.mp3`) from the batch-download
 *     workflow, normalized back to slash form (`audio/xxx.mp3`) so downstream
 *     audioRef lookups resolve.
 *
 * @param {Blob | File} zipBlob
 * @returns {Promise<{classroom: object, bundle: {audio: Record<string, Blob>, media: Record<string, Blob>}}>}
 */
export async function parseMaicZip(zipBlob) {
  const JSZip = globalThis.JSZip;
  if (!JSZip) throw new Error('JSZip is not loaded — check vendor/jszip.min.js is reachable');

  const zip = await JSZip.loadAsync(zipBlob);

  // Root-detection: accept manifest.json at root OR nested one level.
  const manifestEntries = Object.keys(zip.files).filter(
    (p) => !zip.files[p].dir && p.endsWith('manifest.json'),
  );
  if (manifestEntries.length === 0) {
    throw new Error(
      'No manifest.json found in the zip — is this a classroom export? ' +
        'If you compressed a folder, try selecting the files inside and compressing those instead.',
    );
  }
  if (manifestEntries.length > 1) {
    throw new Error(
      `Multiple manifest.json files in zip (${manifestEntries.join(', ')}) — ambiguous layout`,
    );
  }
  const manifestPath = manifestEntries[0];
  const prefix = manifestPath.endsWith('/manifest.json')
    ? manifestPath.slice(0, -'manifest.json'.length)
    : '';

  const manifestText = await zip.file(manifestPath).async('string');
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (err) {
    throw new Error(`manifest.json is not valid JSON: ${err.message}`);
  }

  const classroom = manifestToClassroom(manifest);

  // Collect blobs. Paths normalized to the slash form regardless of how they
  // appeared in the zip.
  const bundle = { audio: {}, media: {} };
  for (const [fullPath, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const path = prefix && fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : fullPath;
    if (path.startsWith('audio/')) {
      bundle.audio[path] = await entry.async('blob');
    } else if (path.startsWith('audio_')) {
      bundle.audio[`audio/${path.slice('audio_'.length)}`] = await entry.async('blob');
    } else if (path.startsWith('media/')) {
      bundle.media[path] = await entry.async('blob');
    } else if (path.startsWith('media_')) {
      bundle.media[`media/${path.slice('media_'.length)}`] = await entry.async('blob');
    }
  }

  return { classroom, bundle };
}

// ---- Entry point #2: single JSON with base64-embedded blobs ----

/**
 * Parse the single-file output of the DevTools console snippet. Decodes
 * `_embeddedAudio` / `_embeddedMedia` data-URLs back into Blobs via native
 * fetch — no external deps, no manual base64 decode loop.
 *
 * @param {string} jsonText
 * @returns {Promise<{classroom: object, bundle: {audio: Record<string, Blob>, media: Record<string, Blob>}}>}
 */
export async function parseEmbeddedJson(jsonText) {
  let manifest;
  try {
    manifest = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`classroom.json is not valid JSON: ${err.message}`);
  }

  const bundle = { audio: {}, media: {} };
  async function dataUrlToBlob(dataUrl) {
    const res = await fetch(dataUrl);
    return res.blob();
  }

  for (const [path, dataUrl] of Object.entries(manifest._embeddedAudio ?? {})) {
    if (typeof dataUrl === 'string' && dataUrl.startsWith('data:')) {
      bundle.audio[path] = await dataUrlToBlob(dataUrl);
    }
  }
  for (const [path, dataUrl] of Object.entries(manifest._embeddedMedia ?? {})) {
    if (typeof dataUrl === 'string' && dataUrl.startsWith('data:')) {
      bundle.media[path] = await dataUrlToBlob(dataUrl);
    }
  }

  // Strip the heavy sidecars so the classroom object doesn't carry
  // base64-inflated duplicates of every blob.
  const { _embeddedAudio: _a, _embeddedMedia: _m, ...lean } = manifest;
  const classroom = manifestToClassroom(lean);
  return { classroom, bundle };
}

/**
 * Cheap heuristic for app.js to decide between parseEmbeddedJson and the
 * legacy plain-classroom path. Returns true if the parsed object looks like
 * an embedded-bundle manifest.
 */
export function looksLikeEmbeddedBundle(obj) {
  return (
    obj &&
    typeof obj === 'object' &&
    typeof obj.formatVersion === 'number' &&
    (obj._embeddedAudio || obj._embeddedMedia)
  );
}

// ---- Summary helper for the UI status line ----

/**
 * @param {{audio: Record<string, Blob>, media: Record<string, Blob>}} bundle
 */
export function bundleSummary(bundle) {
  const audioCount = Object.keys(bundle.audio).length;
  const mediaCount = Object.keys(bundle.media).length;
  const totalBytes = [...Object.values(bundle.audio), ...Object.values(bundle.media)]
    .reduce((sum, blob) => sum + (blob.size || 0), 0);
  return { audioCount, mediaCount, totalBytes };
}
