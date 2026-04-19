// Browser-side mirror of services/exporter/src/exporters/shared/timeline.ts.
// Kept byte-for-byte compatible with the TypeScript original — a parity test
// in the backend repo asserts that the generated timeline JSON, runtime.js
// string, gate DOM fragment, and CSS are identical. See the feedback memory
// ("deliberate duplication with parity tests") for why we duplicate.
//
// Rule: if you change anything in this file, mirror the same change in the
// backend's timeline.ts AND run `pnpm test --ignore-workspace` in
// services/exporter before merging. The parity test will fail loudly if the
// two sides drift.

// Duration constants — keep in sync with lib/action/engine.ts (pointers inline).
export const TIMELINE_DURATIONS = {
  effectAutoClearMs: 5000, // engine.ts:72 — spotlight/laser
  wbOpenMs: 2000, // engine.ts:310
  wbDrawMs: 800, // engine.ts:342
  wbDrawCodeBaseMs: 800, // engine.ts:546
  wbDrawCodePerLineMs: 50, // engine.ts:546
  wbDrawCodeCapMs: 3000, // engine.ts:546
  wbEditCodeMs: 600, // engine.ts:609
  wbDeleteMs: 300, // engine.ts:617
  wbClearMaxMs: 1400, // engine.ts:634
  wbCloseMs: 700, // engine.ts:645
  playVideoFallbackMs: 5000,
  discussionPreCardMs: 3000, // engine.ts:568
  speechFallbackMinMs: 1500,
  speechFallbackMaxMs: 30000,
  speechFallbackMsPerWord: 400,
};

function estimateSpeechFallbackMs(text) {
  const words = String(text || '').trim().split(/\s+/).filter((w) => w.length > 0).length;
  const est = words * TIMELINE_DURATIONS.speechFallbackMsPerWord;
  return Math.max(
    TIMELINE_DURATIONS.speechFallbackMinMs,
    Math.min(est, TIMELINE_DURATIONS.speechFallbackMaxMs),
  );
}

function countCodeLines(code) {
  if (typeof code !== 'string' || code.length === 0) return 1;
  return code.split('\n').length;
}

export function normalizeSceneTimeline(scene, availableAudio) {
  const out = [];
  const actions = Array.isArray(scene && scene.actions) ? scene.actions : [];
  actions.forEach((rawAction) => {
    const action = rawAction || {};
    const type = typeof action.type === 'string' ? action.type : '';
    if (!type) return;
    const idx = out.length;
    switch (type) {
      case 'speech': {
        const text = typeof action.text === 'string' ? action.text : '';
        if (!text.trim()) return;
        const audioRef = typeof action.audioRef === 'string' ? action.audioRef : null;
        const bundled = audioRef && availableAudio && availableAudio.has(audioRef) ? audioRef : null;
        const entry = {
          type: 'speech',
          duration: estimateSpeechFallbackMs(text),
          text,
          captionElementId: 'timeline-caption-' + idx,
        };
        if (bundled) {
          entry.audio = '../' + bundled;
          entry.audioElementId = 'timeline-audio-' + idx;
        }
        out.push(entry);
        return;
      }
      case 'spotlight':
      case 'laser': {
        const elementId = typeof action.elementId === 'string' ? action.elementId : undefined;
        const entry = {
          type,
          duration: TIMELINE_DURATIONS.effectAutoClearMs,
          fireAndForget: true,
        };
        if (elementId) entry.elementId = elementId;
        out.push(entry);
        return;
      }
      case 'wb_open':
        out.push({ type, duration: TIMELINE_DURATIONS.wbOpenMs });
        return;
      case 'wb_close':
        out.push({ type, duration: TIMELINE_DURATIONS.wbCloseMs });
        return;
      case 'wb_clear':
        out.push({ type, duration: TIMELINE_DURATIONS.wbClearMaxMs });
        return;
      case 'wb_delete':
        out.push({ type, duration: TIMELINE_DURATIONS.wbDeleteMs });
        return;
      case 'wb_edit_code':
        out.push({ type, duration: TIMELINE_DURATIONS.wbEditCodeMs });
        return;
      case 'wb_draw_code': {
        const lines = countCodeLines(action.code);
        const dur = Math.min(
          TIMELINE_DURATIONS.wbDrawCodeBaseMs + lines * TIMELINE_DURATIONS.wbDrawCodePerLineMs,
          TIMELINE_DURATIONS.wbDrawCodeCapMs,
        );
        out.push({ type, duration: dur });
        return;
      }
      case 'wb_draw_text':
      case 'wb_draw_shape':
      case 'wb_draw_chart':
      case 'wb_draw_latex':
      case 'wb_draw_table':
      case 'wb_draw_line':
        out.push({ type, duration: TIMELINE_DURATIONS.wbDrawMs });
        return;
      case 'play_video':
        out.push({ type, duration: TIMELINE_DURATIONS.playVideoFallbackMs });
        return;
      case 'discussion':
        out.push({ type, duration: TIMELINE_DURATIONS.discussionPreCardMs });
        return;
      default:
        return;
    }
  });
  return out;
}

export const TIMELINE_CSS = `
  .timeline-gate { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(15, 15, 25, 0.85); display: flex; align-items: center; justify-content: center; cursor: pointer; z-index: 1000; animation: timeline-gate-fade 0.2s ease-out; }
  .timeline-gate-btn { background: #fff; color: #0a0a0a; border: none; border-radius: 999px; padding: 1.25rem 2.5rem; display: flex; align-items: center; gap: 0.75rem; font-size: 1.125rem; font-weight: 600; cursor: pointer; box-shadow: 0 8px 24px rgba(0,0,0,0.3); transition: transform 0.15s ease-out; font-family: inherit; }
  .timeline-gate-btn:hover { transform: scale(1.04); }
  .timeline-gate-icon { font-size: 1.5rem; line-height: 1; }
  .timeline-controls { position: fixed; bottom: 1rem; right: 1rem; display: none; align-items: center; gap: 0.5rem; background: rgba(255, 255, 255, 0.95); padding: 0.5rem 0.75rem; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.12); z-index: 900; font-family: system-ui, sans-serif; font-size: 0.875rem; }
  .timeline-btn { background: #1a1a1a; color: #fff; border: none; border-radius: 4px; padding: 0.4rem 0.75rem; cursor: pointer; font-size: 0.875rem; font-family: inherit; }
  .timeline-btn:hover { background: #000; }
  .timeline-status { color: #6a6a6a; min-width: 4rem; text-align: center; }
  .narration p.timeline-active { background: linear-gradient(120deg, rgba(255, 236, 139, 0.65) 0%, rgba(255, 236, 139, 0.2) 100%); border-left: 3px solid #f5b400; padding: 0.5rem 0.75rem; margin-left: -0.75rem; border-radius: 0 4px 4px 0; transition: background 0.3s ease-out; }
  body[data-timeline-state="ended"] .timeline-controls { background: rgba(233, 247, 233, 0.95); }
  @keyframes timeline-gate-fade { from { opacity: 0; } to { opacity: 1; } }
`;

export function renderTimelineGateDom() {
  return `<div id="timeline-gate" class="timeline-gate" role="button" tabindex="0" aria-label="Start playback">
    <button type="button" class="timeline-gate-btn">
      <span class="timeline-gate-icon" aria-hidden="true">&#9654;</span>
      <span class="timeline-gate-label">Start</span>
    </button>
  </div>
  <div id="timeline-controls" class="timeline-controls" role="group" aria-label="Playback controls">
    <button type="button" id="timeline-playpause" class="timeline-btn">&#9654; Play</button>
    <button type="button" id="timeline-restart" class="timeline-btn">&#8634; Restart</button>
    <span id="timeline-status" class="timeline-status">Ready</span>
  </div>`;
}

// This string MUST stay byte-for-byte identical to the backend's
// TIMELINE_RUNTIME_JS constant in services/exporter/src/exporters/shared/timeline.ts.
// Any drift trips the parity test.
export const TIMELINE_RUNTIME_JS = `/* OpenMAIC timeline runtime (v0.2.0-alpha.3) */
(function () {
  'use strict';

  var timelineEl = document.getElementById('timeline');
  if (!timelineEl) return;
  var entries = [];
  try {
    entries = JSON.parse(timelineEl.textContent || timelineEl.innerText || '[]');
  } catch (e) { entries = []; }

  var gateEl = document.getElementById('timeline-gate');
  var controlsEl = document.getElementById('timeline-controls');
  var statusEl = document.getElementById('timeline-status');
  var playPauseBtn = document.getElementById('timeline-playpause');
  var restartBtn = document.getElementById('timeline-restart');

  // Playback state. \`gated\` is the initial state — modern browsers block
  // audio.play() without a prior user gesture, so we render a click-to-start
  // overlay and only transition out of \`gated\` on user input.
  var state = 'gated';
  var currentIndex = 0;
  var currentTimer = null;
  var remainingMs = 0;
  var timerStartedAt = 0;
  var currentAudio = null;
  var currentAudioCleanup = null;
  var activeCaptionEl = null;

  function setState(s) {
    state = s;
    if (document.body) document.body.setAttribute('data-timeline-state', s);
    if (gateEl) gateEl.style.display = (s === 'gated') ? 'flex' : 'none';
    if (controlsEl) controlsEl.style.display = (s === 'gated') ? 'none' : 'flex';
    if (playPauseBtn) {
      if (s === 'playing') playPauseBtn.innerHTML = '&#10074;&#10074; Pause';
      else if (s === 'ended') playPauseBtn.innerHTML = '&#9654; Replay';
      else playPauseBtn.innerHTML = '&#9654; Play';
    }
    if (statusEl) {
      if (s === 'ended') statusEl.textContent = 'Finished';
      else if (s === 'gated') statusEl.textContent = 'Ready';
      else if (entries.length === 0) statusEl.textContent = '—';
      else statusEl.textContent = (Math.min(currentIndex + 1, entries.length)) + ' / ' + entries.length;
    }
  }

  function setActiveCaption(captionId) {
    if (activeCaptionEl && activeCaptionEl.classList) {
      activeCaptionEl.classList.remove('timeline-active');
    }
    activeCaptionEl = captionId ? document.getElementById(captionId) : null;
    if (activeCaptionEl && activeCaptionEl.classList) {
      activeCaptionEl.classList.add('timeline-active');
    }
  }

  function clearWait() {
    if (currentTimer) { clearTimeout(currentTimer); currentTimer = null; }
  }

  function startWait(ms, done) {
    clearWait();
    remainingMs = ms;
    timerStartedAt = Date.now();
    currentTimer = setTimeout(function () { currentTimer = null; done(); }, ms);
  }

  function pauseWait() {
    if (!currentTimer) return;
    clearWait();
    remainingMs -= (Date.now() - timerStartedAt);
    if (remainingMs < 0) remainingMs = 0;
  }

  function resumeWait(done) {
    if (remainingMs <= 0) { done(); return; }
    timerStartedAt = Date.now();
    currentTimer = setTimeout(function () { currentTimer = null; done(); }, remainingMs);
  }

  function detachAudio() {
    if (currentAudioCleanup) { currentAudioCleanup(); currentAudioCleanup = null; }
    currentAudio = null;
  }

  function playSpeechEntry(entry, advance) {
    var audio = entry.audioElementId ? document.getElementById(entry.audioElementId) : null;
    if (!audio || !('play' in audio)) {
      // No bundled audio — fall back to the caption-duration wait so the
      // caller still sees the caption long enough to read.
      setActiveCaption(entry.captionElementId || null);
      startWait(entry.duration || 1500, advance);
      return;
    }
    currentAudio = audio;
    setActiveCaption(entry.captionElementId || null);
    var cleanup = function () {
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
    };
    var onEnded = function () { cleanup(); currentAudioCleanup = null; currentAudio = null; advance(); };
    var onError = function () { cleanup(); currentAudioCleanup = null; currentAudio = null; advance(); };
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);
    currentAudioCleanup = cleanup;
    try { audio.currentTime = 0; } catch (e) { /* some browsers throw before metadata loads */ }
    var p = audio.play();
    if (p && typeof p.then === 'function') {
      p['catch'](function () {
        // Autoplay blocked despite gate — return to gated state and surface
        // the Start overlay again so the user can retry.
        detachAudio();
        setActiveCaption(null);
        setState('gated');
      });
    }
  }

  function runNext() {
    if (state !== 'playing') return;
    if (currentIndex >= entries.length) {
      setActiveCaption(null);
      setState('ended');
      return;
    }
    var entry = entries[currentIndex];
    currentIndex++;

    if (entry.fireAndForget) {
      // α.6 will render the overlay; for α.3 we just advance immediately.
      // The entry's \`duration\` is still used by α.6 to time the overlay
      // auto-clear — don't consume it here.
      setTimeout(runNext, 0);
      return;
    }

    if (entry.type === 'speech') {
      playSpeechEntry(entry, runNext);
      return;
    }

    // Every other action type: honor the normalized duration and advance.
    // α.5/α.6 will wire actual rendering (whiteboard, video, overlay) in
    // parallel; α.3 just gets the pacing right.
    setActiveCaption(null);
    startWait(entry.duration || 0, runNext);
  }

  function start() {
    if (state === 'gated') {
      setState('playing');
      currentIndex = 0;
      runNext();
    } else if (state === 'paused') {
      setState('playing');
      if (currentAudio) {
        var p = currentAudio.play();
        if (p && typeof p.then === 'function') {
          p['catch'](function () { detachAudio(); setState('gated'); });
        }
      } else {
        resumeWait(runNext);
      }
    } else if (state === 'ended') {
      restart(true);
    }
  }

  function pause() {
    if (state !== 'playing') return;
    setState('paused');
    if (currentAudio) { try { currentAudio.pause(); } catch (e) { /* ignore */ } }
    else { pauseWait(); }
  }

  function restart(autoPlay) {
    clearWait();
    detachAudio();
    setActiveCaption(null);
    currentIndex = 0;
    remainingMs = 0;
    if (autoPlay) {
      setState('playing');
      runNext();
    } else {
      setState('gated');
    }
  }

  if (gateEl) {
    gateEl.addEventListener('click', function () { start(); });
    gateEl.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
        ev.preventDefault();
        start();
      }
    });
  }
  if (playPauseBtn) {
    playPauseBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (state === 'playing') pause();
      else start();
    });
  }
  if (restartBtn) {
    restartBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      restart(false);
    });
  }

  setState('gated');
})();
`;
