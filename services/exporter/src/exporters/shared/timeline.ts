import type { Scene } from '../../validation/classroom.js';

// Action-timeline runtime (α.3). Takes a ClassroomManifest Scene and produces a
// normalized, self-describing timeline array the exported runtime.js can walk
// without needing to know OpenMAIC's full Action schema or its hardcoded
// animation timings.
//
// Why normalize at export time (not in the runtime)?
//   Action durations live in three scattered places in the live OpenMAIC app:
//     - `mediaIndex[audioRef].duration` for speech
//     - hardcoded animation delays in lib/action/engine.ts (whiteboard ops,
//       spotlight/laser auto-clear, discussion pre-card)
//     - `<video>.duration` for play_video (only known at runtime)
//   Porting all of that into the runtime means duplicating ActionEngine.
//   Normalizing here keeps the runtime dumb: each entry is `{ type, duration,
//   fireAndForget?, audio?, ... }` and the runtime just walks it.
//
// DURATION CONSTANTS are duplicated from lib/action/engine.ts. If those
// change upstream and these don't, exported packages will drift from live
// classroom pacing. Each constant has a `engine.ts:NNN` pointer — treat them
// as sync points when touching either file.

export interface TimelineEntry {
  // Verbatim action.type (speech, spotlight, laser, wb_open, wb_draw_text, ...).
  // Unknown types are dropped during normalization; the runtime never sees them.
  type: string;
  // Milliseconds. For speech with a bundled audio element the runtime ignores
  // this and listens for `audio.ended` instead — the value is only a fallback
  // for broken refs or errored playback.
  duration: number;
  // When true, the runtime advances immediately (fire-and-forget, α.6 overlay
  // rendering honors the duration separately). Today only spotlight/laser.
  fireAndForget?: boolean;
  // Speech only — relative path from the scene HTML into the audio folder
  // (e.g. `../audio/tts_sp1.mp3`). Absent when audioRef missing or blob not
  // bundled; runtime falls back to `duration` in that case.
  audio?: string;
  // DOM id of the `<audio>` element in this scene HTML. Runtime uses this to
  // find the right audio for the entry (DOM order isn't reliable — non-speech
  // entries don't emit `<audio>` tags).
  audioElementId?: string;
  // DOM id of the caption `<p>` to highlight during playback. Speech only.
  captionElementId?: string;
  // Caption text — inline with the entry so the runtime can re-surface it in
  // the status bar without reading from the DOM.
  text?: string;
  // Passed through for α.6 spotlight/laser overlay rendering.
  elementId?: string;
}

// Duration constants — keep in sync with lib/action/engine.ts. Each key points
// at the engine line that sources it.
export const TIMELINE_DURATIONS = {
  effectAutoClearMs: 5000, // engine.ts:72 (EFFECT_AUTO_CLEAR_MS) — spotlight/laser
  wbOpenMs: 2000, // engine.ts:310
  wbDrawMs: 800, // engine.ts:342 (text/shape/chart/latex/table/line all share this)
  wbDrawCodeBaseMs: 800, // engine.ts:546
  wbDrawCodePerLineMs: 50, // engine.ts:546
  wbDrawCodeCapMs: 3000, // engine.ts:546
  wbEditCodeMs: 600, // engine.ts:609
  wbDeleteMs: 300, // engine.ts:617
  wbClearMaxMs: 1400, // engine.ts:634 — elementCount unknown at export; use cap
  wbCloseMs: 700, // engine.ts:645
  playVideoFallbackMs: 5000, // native <video>.duration unknown at export; α.5 refines
  discussionPreCardMs: 3000, // engine.ts:568 — pre-card delay; runtime skips the user-gate in α.3
  speechFallbackMinMs: 1500,
  speechFallbackMaxMs: 30_000,
  speechFallbackMsPerWord: 400,
} as const;

// Reading-time fallback used when a speech entry has no bundled audio. Clamped
// so a 1-word caption doesn't flash and a 10k-word monologue doesn't hang the
// scene forever.
function estimateSpeechFallbackMs(text: string): number {
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0).length;
  const est = words * TIMELINE_DURATIONS.speechFallbackMsPerWord;
  return Math.max(
    TIMELINE_DURATIONS.speechFallbackMinMs,
    Math.min(est, TIMELINE_DURATIONS.speechFallbackMaxMs),
  );
}

function countCodeLines(code: unknown): number {
  if (typeof code !== 'string' || code.length === 0) return 1;
  return code.split('\n').length;
}

// Produce the normalized timeline for a single scene. Unknown action types are
// dropped silently — α.5/α.6 may add handlers for new types, and the runtime
// must stay forward-compatible.
export function normalizeSceneTimeline(
  scene: Scene,
  availableAudio: Set<string> | undefined,
): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  const actions = Array.isArray(scene.actions) ? scene.actions : [];

  actions.forEach((rawAction, i) => {
    const action = rawAction as Record<string, unknown>;
    const type = typeof action.type === 'string' ? action.type : '';
    if (!type) return;

    const idx = out.length; // caption/audio DOM ids index into the *output* (rendered) list

    switch (type) {
      case 'speech': {
        const text = typeof action.text === 'string' ? action.text : '';
        if (!text.trim()) return; // skip empty-text speech (matches current renderer behavior)
        const audioRef = typeof action.audioRef === 'string' ? action.audioRef : null;
        const bundled = audioRef && availableAudio?.has(audioRef) ? audioRef : null;
        out.push({
          type: 'speech',
          duration: estimateSpeechFallbackMs(text),
          text,
          captionElementId: `timeline-caption-${idx}`,
          ...(bundled
            ? { audio: `../${bundled}`, audioElementId: `timeline-audio-${idx}` }
            : {}),
        });
        return;
      }
      case 'spotlight':
      case 'laser': {
        const elementId = typeof action.elementId === 'string' ? action.elementId : undefined;
        out.push({
          type,
          duration: TIMELINE_DURATIONS.effectAutoClearMs,
          fireAndForget: true,
          ...(elementId ? { elementId } : {}),
        });
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
        return; // unknown → drop
    }
  });

  return out;
}

// CSS injected into every scene HTML head. Kept as a tagged string so the
// parity test can diff it verbatim. Scoped class names (`timeline-*`) avoid
// collisions with the existing SCENE_CSS/SHARED_CSS selectors.
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

// Rendered once per scene after the narration block. Kept separate from the
// scene renderer so both html/ and scorm1_2/ can call one function and we
// don't drift.
export function renderTimelineGateDom(): string {
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

// The runtime script bundled into every ZIP as `timeline.js`. Kept as a string
// so it ships byte-for-byte identical across backend + UI exporters (parity
// test gated). Intentionally ES5 to survive the lowest-common-denominator
// LMS iframe sandbox (SCORM Cloud still reports IE-class environments in the
// wild). ~150 lines including comments.
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
