# OpenMAIC exporter — v0.2.0-α progress

Living status doc for the "full interactive session export" work. v0.1.0 exported text-only classrooms to SCORM 1.2 + static HTML. v0.2.0 adds audio, action timelines, quizzes, full slide rendering, spotlights. Tagged `v0.2.0-α` when all six sub-tasks ship green.

Six phases, one feature each. Each phase is testable in isolation. Ship when green; don't batch.

## α.1 — `.maic.zip` input (UI + backend) — **SHIPPED**

Both the UI's local-export panel and the backend accept ClassroomManifest-shaped payloads (either the `.maic.zip` that OpenMAIC's v0.1.1 Export-Classroom button produces, or the `.classroom.json` the DevTools snippet produces). The backend's `validation/classroom.ts` got `.passthrough()` + optional ids so manifest-shaped bodies don't fail schema.

**Key files:** `services/ui/public/manifest-adapter.js`, `services/ui/public/app.js`, `services/exporter/src/validation/classroom.ts`, `services/ui/README.md`.

## α.2 — audio bundled into SCORM/HTML ZIP — **SHIPPED**

Sync route `POST /export/:format/from-bundle` accepts the DevTools snippet's full output (ClassroomManifest + `_embeddedAudio` + `_embeddedMedia` base64 maps), decodes in-memory, runs the exporter with a `mediaBundle: Map<string, Buffer>`, streams SCORM/HTML ZIP back on the same connection. Audio entries use STORE compression (MP3 already compressed — DEFLATE wastes CPU); text entries use DEFLATE level 6. Scene HTMLs emit `<audio controls preload="metadata" src="../audio/<id>.mp3">` only for speech actions whose `audioRef` is bundled. SCORM `imsmanifest.xml` lists audio files in the resource dependency set.

**Hardening applied (17 items from plan review):**

- Per-entry compression (STORE for MP3/PNG, DEFLATE for XML/HTML/JS) — JSZip `file(path, data, {compression: ...})`.
- Unicode-safe regex on `_embedded*` keys with length caps: `/^audio\/[A-Za-z0-9_.-]{1,100}\.[A-Za-z0-9]{2,5}$/u`. Rejects path traversal, normalization bypass, pathological extensions.
- MIME ↔ bucket cross-check: `audio/` keys must carry `audio/*` MIME; `media/` accepts `audio|video|image/*`. Rejects PNG-smuggled-into-audio-slot.
- Data-URL decode via comma-slice (`dataUrl.slice(commaIndex + 1)`), not naive `Buffer.from(dataUrl, 'base64')` (which silently corrupts by decoding the `data:audio/mp3;base64,` prefix).
- Error-message discipline: `BundleDecodeError` carries a structural `code` + enumerated `context`; never interpolates request-sourced strings (key, payload, MIME) into the response body.
- Fastify `connectionTimeout` + `keepAliveTimeout` bumped to 300 s for slow uploads. Route documents curl `--max-time 300` / axios `timeout: 300_000`. `keep-alive: timeout=300` response header for compliant clients.
- `@fastify/under-pressure` with 512 MB heap / 900 MB RSS ceiling + Retry-After 30 s. `healthCheck: async () => true` with `healthCheckInterval: 60_000` so `/health` stays green under pressure (K8s liveness unaffected).
- Pino `redact.paths` covers `req.body._embeddedAudio.*` / `req.body._embeddedMedia.*` — a failed 100 MB body otherwise dumps 100 MB of base64 into stdout.
- Per-route `bodyLimit: 100_000_000`; default `/export/:format` keeps 1 MB limit.
- `preValidation` hook rejects non-`application/json` with 415 and bodies <100/>100_000_000 bytes with 400/413 BEFORE buffering.
- `stream/promises.pipeline(zipStream, reply.raw)` for response — propagates errors both directions, destroys source cleanly on client disconnect.
- `reply.hijack()` + `reply.raw.setHeader(...)` pattern (hijacked replies don't flush headers set via `reply.type()`/`reply.header()` — caught in test loop, documented in feedback memory).
- Env-gated `global.gc()` on response finish via `EXPORTER_GC_ON_RESPONSE=true`. Requires `--expose-gc` CMD flag. Off by default.

**Peak memory for one 100 MB /from-bundle request:** ~300-400 MB (raw JSON + parsed object tree + decoded Buffers + JSZip staging). Under-pressure threshold gates concurrency.

**Deferred to v0.3:** multipart/form-data transport (streams body directly to disk/Buffer, avoids the ~3× JSON.parse memory spike). Fine at ≤100 MB JSON bodies for now.

**Verification:**
- `pnpm test` → 54/54 green.
- `pnpm typecheck` → clean.
- `unzip -vl` on synthetic fixture output → `audio/tts_sp1.mp3 Stored`, manifest `Defl:N`, scene 1 HTML emits `<audio src="../audio/tts_sp1.mp3">`, scene 2 (no audioRef) renders silent.
- Fuzz: path traversal → `400 invalid_audio_key` (no echoed path). PNG-in-audio-slot → `400 mime_bucket_mismatch`. `text/plain` → 415 via preValidation.

**Key files added:**
- `services/exporter/src/sources/bundle.ts` — decoder.
- `services/exporter/src/routes/export-from-bundle.ts` — sync route handler.
- `services/exporter/tests/unit/export-from-bundle.test.ts` — 11 cases.

**Key files modified:**
- `services/exporter/src/exporters/types.ts` — `ExportOptions.mediaBundle`.
- `services/exporter/src/exporters/shared/zip.ts` — per-entry compression.
- `services/exporter/src/exporters/scorm1_2/{index,manifest,render-slide}.ts` — audio STORE, resource refs, `<audio>` tags, id-fallback for ClassroomManifest input.
- `services/exporter/src/exporters/html/{index,render-scene,render-toc}.ts` — audio STORE, `<audio>` tags, id-fallback.
- `services/exporter/src/validation/classroom.ts` — `audioRef` on SpeechActionSchema.
- `services/exporter/src/server.ts` — under-pressure, logger redact, 300 s timeouts.
- `services/exporter/src/config.ts` — `EXPORTER_GC_ON_RESPONSE`.
- `services/exporter/package.json` — `@fastify/under-pressure@^9.0.3`.
- `services/ui/public/exporters/{scorm1_2,html}.js` — parity-mirrored (audio STORE + audioRef + id-fallback + per-entry compression in `buildZipBlob`).

**Curl smoke-test recipe** (keep for α.3+ smoke tests):
```bash
TOK=$(grep EXPORTER_AUTH_TOKEN /home/narthanaj/Desktop/repositories/openmaic/OpenMAIC/.env.local | cut -d= -f2)
curl --max-time 300 -sS -X POST http://127.0.0.1:4000/export/scorm1.2/from-bundle \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  --data-binary @/tmp/fixture.classroom.json -o /tmp/out.zip \
  -w "HTTP %{http_code}  size=%{size_download}  time=%{time_total}s\n"
unzip -vl /tmp/out.zip
```

Fixture builder: `/tmp/build-fixture.js` (40-byte fake MP3 + 2 scenes). Regenerate with `node /tmp/build-fixture.js`.

## α.3 — action-timeline runtime — **SHIPPED**

Every exported ZIP now contains a `timeline.js` playback engine that walks a
per-scene normalized timeline inlined as `<script type="application/json"
id="timeline">` in each scene HTML. Speech actions auto-advance on
`<audio>.ended`; everything else waits out a duration normalized at export
time from `lib/action/engine.ts` constants. A full-page **gate overlay**
covers the scene until first user click — that satisfies every browser's
autoplay policy so the first `audio.play()` never throws `NotAllowedError`.
Pause/Resume preserve remaining-duration for non-audio waits; Restart returns
to the gated state.

**Answers to the open questions from α.3-next:**
- *Timeline format* — **normalize at export time**, not in the runtime. Action
  durations live scattered across `mediaIndex`, hardcoded ActionEngine values,
  and native video metadata; duplicating that logic into the runtime is a
  ported-ActionEngine tax. The normalizer emits `{ type, duration, fireAndForget?,
  audio?, audioElementId?, captionElementId?, text?, elementId? }` per entry.
- *Runtime* — **fresh ~170 LOC vanilla JS** (ES5 for LMS-iframe compat), not
  a port of `lib/playback/engine.ts`. That engine is 751 LOC tied to Zustand
  + React canvas stores; stripping it costs more than writing fresh. The v1
  runtime is a state machine with `gated | playing | paused | ended` and a
  wait-or-audio-await per entry.
- *SCORM integration* — **client-side only**. `runtime.js` (LMS shim, untouched)
  and `timeline.js` (playback) are separate scripts, single-responsibility.
  `cmi.core.lesson_location` is 255 chars and bookmark-intent — not the right
  place for fine-grained progress. α.4 will add `cmi.core.score.raw` for
  quiz scoring.

**Scope boundary** (deferred to α.5/α.6): the runtime does *not* render
whiteboard elements or spotlight/laser overlays yet. For those actions it
just honors the normalized duration (wait + advance). α.5 adds slide/
whiteboard rendering; α.6 adds overlay drawing and reuses the same timeline
JSON — `elementId` and `fireAndForget` are already passed through.

**Hardening / UX details:**
- Autoplay gate (`state: gated` initial) + re-gate on any `play()` promise
  rejection — defensive even though first-click should satisfy the policy.
- Inline JSON escapes `<` → `\u003c` so `</script>` inside caption text can't
  close the `<script type="application/json">` block early.
- `<audio>` elements ship without `controls` (runtime drives play/pause) but
  keep `preload="metadata"` so the ZIP doesn't try to eagerly stream every
  MP3 on page load in the LMS iframe.
- Active caption highlighting via `.timeline-active` class — no JS layout
  work, just a CSS class swap.
- `wb_draw_code` duration scales by line count (`800 + 50 · lines`, capped
  at 3000ms) matching ActionEngine exactly; `wb_clear` uses the 1400ms cap
  (elementCount unknown at export).
- Unknown action types are silently dropped from the timeline, forward-
  compatible with α.5/α.6 additions.
- `TIMELINE_DURATIONS` constants in `shared/timeline.ts` each have a pointer
  comment to the engine.ts line they mirror — sync points for future edits.

**Verification:**
- `pnpm --ignore-workspace test` → **67/67 green** (was 54; +11 normalizer
  cases, +assertions in parity & export-from-bundle suites).
- `pnpm --ignore-workspace typecheck` → clean.
- `docker compose up -d --build --no-deps exporter ui` → both healthy.
- Smoke: multi-action fixture (speech + spotlight + wb_draw_text + speech +
  discussion) through `/export/{scorm1.2,html}/from-bundle` → both ZIPs
  contain `timeline.js` (Defl:N) at root, scene HTML has inline timeline
  JSON with correct 5 entries + gate DOM + `timeline-caption-N` /
  `timeline-audio-N` ids + `<script src="../timeline.js" defer>`. SCORM
  manifest lists `timeline.js` as a resource dep. `diff` confirms
  `timeline.js` is byte-identical across both output formats.
- Parity test gates backend TS vs browser JS outputs scene-by-scene; fixture
  extended with non-speech actions so the normalizer's timeline JSON is in
  the diff surface.
- **Not** interactively browser-tested by me — the gate overlay click flow
  needs a human confirming audio auto-advance + pause/resume + caption
  highlight advance feels right. Mechanically everything's wired.

**Key files added:**
- `services/exporter/src/exporters/shared/timeline.ts` — normalizer,
  `TIMELINE_DURATIONS`, `TIMELINE_CSS`, `renderTimelineGateDom()`,
  `TIMELINE_RUNTIME_JS` string.
- `services/ui/public/exporters/shared-timeline.js` — byte-identical mirror.
- `services/exporter/tests/unit/timeline-normalizer.test.ts` — 11 unit cases.

**Key files modified:**
- `services/exporter/src/exporters/html/{index,render-scene}.ts` — ships
  `timeline.js` at ZIP root; scene HTML injects inline JSON + gate + controls.
- `services/exporter/src/exporters/scorm1_2/{index,render-slide,manifest}.ts`
  — same; manifest now lists `timeline.js` in the resource file set.
- `services/ui/public/exporters/{html,scorm1_2}.js` — parity mirrors.
- `tests/unit/exporter-parity.test.ts` — fixture extended with spotlight +
  wb_draw_text in scene 2 so non-speech entries flow through the parity diff.
- `tests/unit/export-from-bundle.test.ts` — asserts `timeline.js` present,
  inline timeline script + gate DOM + `../timeline.js` script tag in scene
  HTML, `<file href="timeline.js"/>` in SCORM manifest.

**Curl smoke-test recipe** (multi-action):
```bash
TOK=$(grep EXPORTER_AUTH_TOKEN /home/narthanaj/Desktop/repositories/openmaic/OpenMAIC/.env.local | cut -d= -f2)
# Build a fixture with speech + spotlight + wb_draw_text + speech + discussion.
node -e '
const fake = Buffer.from([0xff,0xfb,0x90,0x64, ...new Array(36).fill(0)]);
const dataUrl = "data:audio/mpeg;base64," + fake.toString("base64");
process.stdout.write(JSON.stringify({
  formatVersion:1, exportedAt:new Date().toISOString(), appVersion:"smoke",
  stage:{name:"Smoke",language:"en"}, agents:[],
  scenes:[{type:"slide",title:"Smoke",order:0,actions:[
    {type:"speech",id:"sp1",text:"Hello.",audioRef:"audio/sp1.mp3"},
    {type:"spotlight",id:"spot1",elementId:"x"},
    {type:"wb_draw_text",id:"dt1",content:"note",x:0,y:0},
    {type:"speech",id:"sp2",text:"Done.",audioRef:"audio/sp2.mp3"},
  ]}],
  mediaIndex:{"audio/sp1.mp3":{type:"audio",format:"mp3"},
              "audio/sp2.mp3":{type:"audio",format:"mp3"}},
  _embeddedAudio:{"audio/sp1.mp3":dataUrl,"audio/sp2.mp3":dataUrl},
  _embeddedMedia:{},
}));' > /tmp/smoke.json
curl --max-time 60 -sS -X POST http://127.0.0.1:4000/export/scorm1.2/from-bundle \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  --data-binary @/tmp/smoke.json -o /tmp/smoke-scorm.zip \
  -w "HTTP %{http_code}  size=%{size_download}\n"
unzip -l /tmp/smoke-scorm.zip
```
Expected: `timeline.js` at root, scene 001.html has inline timeline JSON
with 4 entries, `timeline-caption-0/3` ids, `timeline-audio-0/3` ids.

## α.4 — quiz widget + SCORM scoring — **NEXT**

`cmi.core.score.raw` + `cmi.core.lesson_status = 'passed' | 'failed'`. Quiz rendering in the HTML-only export needs a JS widget (vanilla, no deps). LMS integration in SCORM uses the existing `runtime.js` shim — extend it with a `reportScore(n)` function the quiz widget calls on submit.

## α.5 — slide rendering — pending

Decide: adapt PPTist's renderer (big, canvas-based, full fidelity) OR minimal renderer (DOM + CSS, pick-the-subset-we-need). Probably minimal for v0.2.0 — users on iPads + LMSs with iframe sandboxes will thank us.

## α.6 — spotlight/laser overlays + parity + tag v0.2.0-α

Spotlight = the classroom's "zoom in on this area" action. Laser = the cursor-trail highlight. Both need overlay rendering during the action's duration window. Parity test extended to cover the new runtime JS + HTML diffs. Tag `v0.2.0-α` on the release branch.

## Tooling / ops notes

- `pnpm install` in `services/exporter` always use `--ignore-workspace` (the parent `pnpm-workspace.yaml` includes only `packages/*`; without the flag, pnpm walks up and skips the exporter's own lockfile). Docker `--frozen-lockfile` catches this, but only at build time.
- `services/exporter/src/exporters/*` and `services/ui/public/exporters/*.js` are deliberately duplicated. Parity test at `tests/unit/exporter-parity.test.ts` diffs the two; any change to one side must land on the other.
- Image tag: `openmaic-exporter:${IMAGE_TAG:-latest}`. Parameterized for rollback.
- `EXPORTER_GC_ON_RESPONSE=true` + `--expose-gc` at the Dockerfile CMD level if RSS stays elevated after big /from-bundle responses. Off by default.
