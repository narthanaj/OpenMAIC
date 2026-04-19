// SCORM 1.2 runtime shim. This string is bundled into every exported ZIP as
// `runtime.js` and included by every slide via <script src="runtime.js" defer>.
//
// Responsibilities:
//   1. Locate the LMS's `window.API` object (SCORM 1.2 spec: walk up parent windows).
//   2. Call LMSInitialize() once per session.
//   3. Track time on task via LMSSetValue("cmi.core.session_time", ...).
//   4. Mark the session `completed` when the last slide is shown.
//   5. Call LMSCommit() + LMSFinish() on window unload.
//
// The shim is intentionally small — it does NOT try to provide cross-browser polyfills
// for edge cases, and it silently no-ops when no LMS API is found (so the package
// remains viewable as a standalone web preview outside any LMS, which is how authors
// typically sanity-check exports before uploading).

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
