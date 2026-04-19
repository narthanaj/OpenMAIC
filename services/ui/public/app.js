// OpenMAIC Exporter UI — main orchestration module.
//
// Architecture: local-first. The "Local export" panel does ALL its work in the
// browser — parse JSON, template HTML/XML, JSZip, trigger native download. Zero
// network traffic. The "Automation mode" panel is for server-to-server callers;
// it POSTs to /api/export/:format and polls /api/export/jobs/:id.
//
// Patterns used here that matter:
//   - apiFetch wrapper surfaces HTTP status codes as readable banners (no silent failures).
//   - 50 ms yield before CPU-heavy JSZip work so the "Zipping..." state actually paints.
//   - URL.revokeObjectURL scheduled 1s after download click to reclaim tab memory.
//   - Recursive setTimeout polling with a 5-minute per-job ceiling to prevent infinite polls.
//   - Download filename derived from user-supplied filename first, never hardcoded.

// ============================================================================
// State (module-scoped).
// ============================================================================

/** @type {File | null} */
let uploadedFile = null;
/** @type {unknown | null} */
let parsedClassroom = null;
/** @type {{audio: Record<string, Blob>, media: Record<string, Blob>} | null} — bundle from a .maic.zip upload (α.2 exporter consumes this) */
let uploadedBundle = null;
/** @type {string | null} — 'scorm1.2' | 'html' */
let currentLocalFormat = null;

/** Map<jobId, { firstPolledAt: number, timer: number | null }> */
const jobPollers = new Map();

const POLL_INTERVAL_MS = 3_000;
const POLL_CEILING_MS = 5 * 60 * 1_000;

// ============================================================================
// Tiny utilities.
// ============================================================================

/** Slugify a string to a filename-safe segment. Returns '' if the input is empty. */
function slugify(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80);
}

/** Format an epoch-ms timestamp as a short relative age ("12s ago", "3m ago"). */
function relTime(ms) {
  const d = Math.max(0, Date.now() - ms);
  if (d < 60_000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  return `${Math.floor(d / 3_600_000)}h ago`;
}

/** Escape HTML for safe injection into innerText-like paths. */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Derive a download filename for the given format. See the feedback memory: never hardcode IDs. */
function deriveFilename(format) {
  // 1. User's source filename wins.
  if (uploadedFile?.name) {
    const base = uploadedFile.name.replace(/\.json$/i, '').trim();
    if (base) return `${sanitizeFs(base)}-${format}.zip`;
  }
  // 2. Slug of the classroom's stage.name.
  const title = parsedClassroom?.stage?.name;
  if (typeof title === 'string' && title.trim()) {
    const slug = slugify(title);
    if (slug) return `${slug}-${format}.zip`;
  }
  // 3. Classroom id.
  const id = parsedClassroom?.id;
  if (typeof id === 'string' && id.trim()) {
    return `${sanitizeFs(id)}-${format}.zip`;
  }
  // 4. Generic.
  return `export-${format}.zip`;
}

/** Strip filesystem-hostile characters from an arbitrary string. */
function sanitizeFs(s) {
  return String(s).replace(/[\/\\:*?"<>|\x00]/g, '_');
}

// ============================================================================
// Classroom shape sniff (minimal — the browser exporter does its own deeper check).
// ============================================================================

/** Returns { ok: true, classroom } or { ok: false, reason }. */
function sniffClassroom(obj) {
  if (!obj || typeof obj !== 'object') return { ok: false, reason: 'not a JSON object' };
  if (!obj.stage || typeof obj.stage !== 'object') return { ok: false, reason: 'missing stage' };
  if (typeof obj.stage.name !== 'string' || !obj.stage.name.trim()) {
    return { ok: false, reason: 'missing stage.name' };
  }
  if (!Array.isArray(obj.scenes) || obj.scenes.length === 0) {
    return { ok: false, reason: 'scenes must be a non-empty array' };
  }
  return { ok: true, classroom: obj };
}

// ============================================================================
// apiFetch — centralized fetch wrapper with readable error surfacing.
// ============================================================================

/**
 * Wraps fetch; on non-2xx or network error, throws with a user-friendly `message`.
 * Callers catch and render the message into a banner.
 */
async function apiFetch(path, init = {}) {
  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw new Error(`Can't reach exporter — check that Docker containers are running (${err.message ?? err})`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Proxy auth misconfigured — check docker-compose environment (${res.status})`);
  }
  if (res.status === 413) {
    throw new Error(`Payload too large — the backend caps request bodies`);
  }
  if (res.status === 502 || res.status === 503) {
    throw new Error(`Exporter is unreachable or restarting (${res.status}) — try again in a moment`);
  }
  if (!res.ok) {
    // Try to parse a structured error; fall back to status text.
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.error ? `${body.error}${body.detail ? ': ' + body.detail : ''}` : '';
    } catch {
      /* ignore */
    }
    throw new Error(detail || `Unexpected error (HTTP ${res.status})`);
  }
  return res;
}

// ============================================================================
// Local export panel.
// ============================================================================

const $localFormat = document.getElementById('local-format');
const $localFile = document.getElementById('local-file');
const $localFileStatus = document.getElementById('local-file-status');
const $localPaste = document.getElementById('local-paste');
const $localBtn = document.getElementById('local-export-btn');
const $localStatus = document.getElementById('local-status');
const $localError = document.getElementById('local-error');

function setLocalError(msg) {
  if (!msg) {
    $localError.classList.add('hidden');
    $localError.textContent = '';
    return;
  }
  $localError.classList.remove('hidden');
  $localError.textContent = msg;
}

function setLocalFileStatus(kind, text) {
  $localFileStatus.className = `file-status ${kind}`;
  $localFileStatus.textContent = text;
}

function refreshExportButtonEnabled() {
  $localBtn.disabled = !parsedClassroom || !currentLocalFormat;
}

async function onFileChange(ev) {
  setLocalError(null);
  const file = ev.target.files?.[0];
  if (!file) {
    uploadedFile = null;
    parsedClassroom = null;
    uploadedBundle = null;
    setLocalFileStatus('', '');
    refreshExportButtonEnabled();
    return;
  }
  if (file.size > 500 * 1024 * 1024) {
    // Raised the ceiling from 100 to 500 MB for .maic.zip bundles carrying audio.
    setLocalFileStatus('err', `File is ${(file.size / 1024 / 1024).toFixed(0)} MB — larger than 500 MB is not supported`);
    uploadedFile = null;
    parsedClassroom = null;
    uploadedBundle = null;
    refreshExportButtonEnabled();
    return;
  }
  try {
    setLocalFileStatus('', `Reading ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)…`);

    // Branch on extension: .zip / .maic.zip → OpenMAIC's ClassroomManifest bundle;
    // .json → legacy single-file classroom (v0.1.0 compatibility).
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.zip')) {
      const { parseMaicZip, bundleSummary } = await import('./manifest-adapter.js');
      const { classroom, bundle } = await parseMaicZip(file);
      const sniff = sniffClassroom(classroom);
      if (!sniff.ok) {
        setLocalFileStatus('err', `✗ ${file.name} — manifest rejected: ${sniff.reason}`);
        uploadedFile = null;
        parsedClassroom = null;
        uploadedBundle = null;
      } else {
        uploadedFile = file;
        parsedClassroom = classroom;
        uploadedBundle = bundle;
        const { audioCount, mediaCount, totalBytes } = bundleSummary(bundle);
        const sceneCount = classroom.scenes.length;
        const bundleMb = (totalBytes / 1024 / 1024).toFixed(1);
        setLocalFileStatus(
          'ok',
          `✓ ${file.name} — ${sceneCount} scene${sceneCount === 1 ? '' : 's'}, ${audioCount} audio, ${mediaCount} media (${bundleMb} MB bundled)`,
        );
        $localPaste.value = '';
      }
    } else {
      // .json path — could be either:
      //   (a) the single-file output of the DevTools console snippet, which
      //       embeds audio/media as base64 in _embeddedAudio / _embeddedMedia;
      //   (b) a legacy plain-classroom .json from v0.1.0 (text-only).
      // looksLikeEmbeddedBundle decides which parser to invoke.
      const text = await file.text();
      let obj;
      try {
        obj = JSON.parse(text);
      } catch (err) {
        throw new Error(`not valid JSON: ${err.message}`);
      }
      const { looksLikeEmbeddedBundle, parseEmbeddedJson, bundleSummary } = await import('./manifest-adapter.js');
      if (looksLikeEmbeddedBundle(obj)) {
        const { classroom, bundle } = await parseEmbeddedJson(text);
        const sniff = sniffClassroom(classroom);
        if (!sniff.ok) {
          setLocalFileStatus('err', `✗ ${file.name} — manifest rejected: ${sniff.reason}`);
          uploadedFile = null;
          parsedClassroom = null;
          uploadedBundle = null;
        } else {
          uploadedFile = file;
          parsedClassroom = classroom;
          uploadedBundle = bundle;
          const { audioCount, mediaCount, totalBytes } = bundleSummary(bundle);
          const sceneCount = classroom.scenes.length;
          const bundleMb = (totalBytes / 1024 / 1024).toFixed(1);
          setLocalFileStatus(
            'ok',
            `✓ ${file.name} — ${sceneCount} scene${sceneCount === 1 ? '' : 's'}, ${audioCount} audio, ${mediaCount} media (${bundleMb} MB decoded)`,
          );
          $localPaste.value = '';
        }
      } else {
        // Legacy plain-classroom JSON.
        const sniff = sniffClassroom(obj);
        if (!sniff.ok) {
          setLocalFileStatus('err', `✗ ${file.name} rejected: ${sniff.reason}`);
          uploadedFile = null;
          parsedClassroom = null;
          uploadedBundle = null;
        } else {
          uploadedFile = file;
          parsedClassroom = sniff.classroom;
          uploadedBundle = null;
          const sceneCount = sniff.classroom.scenes.length;
          setLocalFileStatus(
            'ok',
            `✓ ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB) parsed — ${sceneCount} scene${sceneCount === 1 ? '' : 's'} — no audio bundle (upload .maic.zip or embedded .classroom.json for narration)`,
          );
          $localPaste.value = '';
        }
      }
    }
  } catch (err) {
    setLocalFileStatus('err', `✗ ${file.name}: ${err.message ?? 'could not parse'}`);
    uploadedFile = null;
    parsedClassroom = null;
    uploadedBundle = null;
  }
  refreshExportButtonEnabled();
}

function onPasteChange() {
  setLocalError(null);
  const text = $localPaste.value;
  if (!text.trim()) {
    // Paste cleared — fall back to any uploaded file, else nothing.
    if (!uploadedFile) {
      parsedClassroom = null;
      uploadedBundle = null;
      setLocalFileStatus('', '');
    }
    refreshExportButtonEnabled();
    return;
  }
  try {
    const obj = JSON.parse(text);
    const sniff = sniffClassroom(obj);
    if (!sniff.ok) {
      setLocalFileStatus('err', `✗ Pasted JSON rejected: ${sniff.reason}`);
      parsedClassroom = null;
      uploadedBundle = null;
    } else {
      uploadedFile = null;
      parsedClassroom = sniff.classroom;
      uploadedBundle = null; // paste path has no bundle — text-only export
      setLocalFileStatus('ok', `✓ Pasted classroom parsed — ${sniff.classroom.scenes.length} scenes (no audio bundle)`);
      $localFile.value = ''; // clear the file input visually
    }
  } catch (err) {
    setLocalFileStatus('err', `✗ Pasted JSON: ${err.message ?? 'parse error'}`);
    parsedClassroom = null;
    uploadedBundle = null;
  }
  refreshExportButtonEnabled();
}

function onFormatChange() {
  currentLocalFormat = $localFormat.value || null;
  refreshExportButtonEnabled();
}

async function onExportClick() {
  if (!parsedClassroom || !currentLocalFormat) return;

  setLocalError(null);
  const originalLabel = $localBtn.textContent;
  $localBtn.disabled = true;
  $localBtn.textContent = 'Zipping… (do not close tab)';
  $localStatus.textContent = '';

  // Critical: yield 50ms so the browser actually repaints the disabled state
  // BEFORE we peg the event loop with JSZip work. See the feedback memory.
  await new Promise((r) => setTimeout(r, 50));

  const started = performance.now();
  let objectUrl = null;
  try {
    // Dynamically import the format-specific browser exporter.
    const mod = await import(`./exporters/${currentLocalFormat.replace('.', '_')}.js`);
    const blob = await mod.buildZipBlob(parsedClassroom);
    const elapsed = ((performance.now() - started) / 1000).toFixed(2);

    objectUrl = URL.createObjectURL(blob);
    const filename = deriveFilename(currentLocalFormat.replace('.', '_'));
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    $localStatus.textContent = `✓ ${filename} (${(blob.size / 1024 / 1024).toFixed(2)} MB) in ${elapsed}s`;
  } catch (err) {
    console.error('local export failed', err);
    setLocalError(`Export failed: ${err.message ?? err}`);
  } finally {
    // Revoke object URL ~1s after the click so the browser has started reading the download.
    if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    $localBtn.disabled = !parsedClassroom || !currentLocalFormat;
    $localBtn.textContent = originalLabel;
  }
}

$localFile.addEventListener('change', onFileChange);
$localPaste.addEventListener('input', onPasteChange);
$localFormat.addEventListener('change', onFormatChange);
$localBtn.addEventListener('click', onExportClick);

// ============================================================================
// Automation panel.
// ============================================================================

const $autoFormat = document.getElementById('auto-format');
const $autoClassroomId = document.getElementById('auto-classroom-id');
const $autoWebhook = document.getElementById('auto-webhook');
const $autoSubmit = document.getElementById('auto-submit-btn');
const $autoStatus = document.getElementById('auto-status');
const $autoError = document.getElementById('auto-error');
const $jobsTbody = document.getElementById('jobs-tbody');

function setAutoError(msg) {
  if (!msg) {
    $autoError.classList.add('hidden');
    $autoError.textContent = '';
    return;
  }
  $autoError.classList.remove('hidden');
  $autoError.textContent = msg;
}

async function onAutoSubmit() {
  setAutoError(null);
  const format = $autoFormat.value;
  const classroomId = $autoClassroomId.value.trim();
  const webhookUrl = $autoWebhook.value.trim();
  if (!format) return setAutoError('Pick a format');
  if (!classroomId) return setAutoError('classroomId is required');

  const body = { classroomId };
  if (webhookUrl) body.webhookUrl = webhookUrl;

  const prevLabel = $autoSubmit.textContent;
  $autoSubmit.disabled = true;
  $autoSubmit.textContent = 'Submitting…';
  $autoStatus.textContent = '';
  try {
    const res = await apiFetch(`/api/export/${encodeURIComponent(format)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const { jobId } = await res.json();
    $autoStatus.textContent = `Queued ${jobId.slice(0, 8)}…`;
    // Immediately refresh the jobs list so the new row shows up.
    loadJobs();
  } catch (err) {
    setAutoError(err.message ?? String(err));
  } finally {
    $autoSubmit.disabled = false;
    $autoSubmit.textContent = prevLabel;
  }
}

$autoSubmit.addEventListener('click', onAutoSubmit);

// ============================================================================
// Jobs table — initial load + recursive-setTimeout polling per active row.
// ============================================================================

function statusBadgeHtml(status) {
  return `<span class="badge ${esc(status)}">${esc(status)}</span>`;
}

function actionCellHtml(job) {
  if (job.status === 'done') {
    return `<a href="/api/export/jobs/${encodeURIComponent(job.id)}/download" download>Download</a>`;
  }
  if (job.status === 'failed') {
    return `<span class="muted" title="${esc(job.error ?? '')}">${esc((job.error ?? 'failed').slice(0, 60))}</span>`;
  }
  if (job.status === 'timeout') {
    return `<a href="#" data-refresh-job="${esc(job.id)}">Refresh</a>`;
  }
  return '<span class="muted">…</span>';
}

function renderJobs(jobs) {
  if (!jobs.length) {
    $jobsTbody.innerHTML = `<tr class="empty-row"><td colspan="4">No jobs yet — submit one above.</td></tr>`;
    return;
  }
  $jobsTbody.innerHTML = jobs
    .map(
      (j) => `<tr data-job-id="${esc(j.id)}">
        <td>${esc(j.format)}</td>
        <td>${statusBadgeHtml(j.status)}</td>
        <td title="${new Date(j.createdAt).toISOString()}">${relTime(j.createdAt)}</td>
        <td>${actionCellHtml(j)}</td>
      </tr>`,
    )
    .join('');
  // Wire up click-to-copy on each row.
  $jobsTbody.querySelectorAll('tr[data-job-id]').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      const target = /** @type {HTMLElement} */ (e.target);
      if (target.tagName === 'A') return;
      const id = tr.getAttribute('data-job-id');
      if (id) navigator.clipboard?.writeText(id);
    });
  });
  // Wire up "Refresh" links for timed-out rows.
  $jobsTbody.querySelectorAll('a[data-refresh-job]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const jobId = a.getAttribute('data-refresh-job');
      if (jobId) void refreshSingleJob(jobId);
    });
  });
}

async function loadJobs() {
  try {
    const res = await apiFetch('/api/export/jobs?limit=50');
    const { jobs } = await res.json();
    const sorted = (jobs ?? []).slice().sort((a, b) => b.createdAt - a.createdAt);
    renderJobs(sorted);
    // Start polling for any non-terminal jobs we don't already poll.
    for (const job of sorted) {
      if (job.status === 'pending' || job.status === 'running') {
        if (!jobPollers.has(job.id)) schedulePoll(job.id);
      }
    }
  } catch (err) {
    $jobsTbody.innerHTML = `<tr class="empty-row"><td colspan="4">${esc(err.message ?? 'Failed to load jobs')}</td></tr>`;
  }
}

async function refreshSingleJob(jobId) {
  try {
    const res = await apiFetch(`/api/export/jobs/${encodeURIComponent(jobId)}`);
    const job = await res.json();
    await loadJobs(); // re-render with fresh data
    if (job.status === 'pending' || job.status === 'running') {
      // user manually re-engaged → reset the ceiling by clearing + rescheduling
      clearPoller(jobId);
      schedulePoll(jobId);
    }
  } catch (err) {
    setAutoError(err.message ?? String(err));
  }
}

function clearPoller(jobId) {
  const entry = jobPollers.get(jobId);
  if (entry?.timer != null) clearTimeout(entry.timer);
  jobPollers.delete(jobId);
}

function schedulePoll(jobId, firstPolledAt = Date.now()) {
  if (!jobPollers.has(jobId)) jobPollers.set(jobId, { firstPolledAt, timer: null });
  const entry = jobPollers.get(jobId);
  entry.timer = setTimeout(() => void pollOnce(jobId, firstPolledAt), POLL_INTERVAL_MS);
}

async function pollOnce(jobId, firstPolledAt) {
  const elapsed = Date.now() - firstPolledAt;
  if (elapsed > POLL_CEILING_MS) {
    // Per the plan: flip to "timeout", stop polling, show Refresh link.
    const tr = document.querySelector(`tr[data-job-id="${CSS.escape(jobId)}"]`);
    if (tr) {
      tr.querySelector('td:nth-child(2)').innerHTML = statusBadgeHtml('timeout');
      tr.querySelector('td:nth-child(4)').innerHTML = actionCellHtml({ id: jobId, status: 'timeout' });
      tr.querySelectorAll('a[data-refresh-job]').forEach((a) => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          void refreshSingleJob(jobId);
        });
      });
    }
    clearPoller(jobId);
    return;
  }
  try {
    const res = await apiFetch(`/api/export/jobs/${encodeURIComponent(jobId)}`);
    const job = await res.json();
    const tr = document.querySelector(`tr[data-job-id="${CSS.escape(jobId)}"]`);
    if (tr) {
      tr.querySelector('td:nth-child(2)').innerHTML = statusBadgeHtml(job.status);
      tr.querySelector('td:nth-child(4)').innerHTML = actionCellHtml(job);
      // Re-wire any Refresh/Download links.
      tr.querySelectorAll('a[data-refresh-job]').forEach((a) => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          void refreshSingleJob(jobId);
        });
      });
    }
    if (job.status === 'pending' || job.status === 'running') {
      // Keep polling with the same firstPolledAt — ceiling is cumulative.
      schedulePoll(jobId, firstPolledAt);
    } else {
      clearPoller(jobId);
    }
  } catch {
    // Transient error — count against the same budget by rescheduling under the same firstPolledAt.
    schedulePoll(jobId, firstPolledAt);
  }
}

// ============================================================================
// Bootstrap: load formats, paint initial state.
// ============================================================================

async function loadFormats() {
  try {
    const res = await apiFetch('/api/formats');
    const { formats } = await res.json();
    const opts = formats.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('');
    $localFormat.innerHTML = opts;
    $autoFormat.innerHTML = opts;
    currentLocalFormat = $localFormat.value || null;
    refreshExportButtonEnabled();
  } catch (err) {
    $localFormat.innerHTML = '<option value="">(load failed)</option>';
    $autoFormat.innerHTML = '<option value="">(load failed)</option>';
    setLocalError(`Could not load formats: ${err.message ?? err}`);
  }
}

loadFormats();
loadJobs();
