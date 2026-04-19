# @openmaic/exporter-ui

Lightweight web UI for the OpenMAIC content exporter sidecar. Lets you export classrooms to SCORM 1.2 or static HTML without touching the terminal.

## Two modes

### Local export (primary, browser-only)

You upload a `classroom.json` file (or paste it in). The browser parses it, builds the SCORM/HTML package, zips it with JSZip, and triggers a native download — **no network traffic, no backend involvement, works offline**. Sub-second for small classrooms, a few seconds for 40 MB+.

This is the path you want when you have a classroom stored only in the browser's IndexedDB (standard for UI-generated OpenMAIC classrooms).

**Getting a classroom out of OpenMAIC — two paths depending on your build:**

**Path A: OpenMAIC's built-in "Export Classroom ZIP" button** — if you can find it. The v0.1.1 feature lives in the classroom header's Export dropdown next to PPTX / Resource Pack. Not every build wires it into the visible dropdown. If it's there, click it, get a `.maic.zip`, upload. Done.

**Path B: DevTools console snippet** — if Path A isn't available in your build. Paste the snippet below into DevTools Console on any OpenMAIC page. It reads the IndexedDB tables, embeds every audio/media blob as base64 inside a single manifest JSON, and triggers one download. No CDN deps, no CSP issues, no multi-download rate-limiting, no OS-zip step.

```js
(async () => {
  const STAGE_ID = 'YOUR_CLASSROOM_ID';   // change to your id; null = first classroom found

  const db = await new Promise((ok, no) => {
    const r = indexedDB.open('MAIC-Database');
    r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
  });
  const all = (store, query, idx) => new Promise((ok, no) => {
    const tx = db.transaction(store, 'readonly');
    const src = idx ? tx.objectStore(store).index(idx) : tx.objectStore(store);
    const req = query ? src.getAll(query) : src.getAll();
    req.onsuccess = () => ok(req.result); req.onerror = () => no(req.error);
  });
  const one = (store, key) => new Promise((ok, no) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = () => ok(req.result); req.onerror = () => no(req.error);
  });
  const b64 = (blob) => new Promise((ok, no) => {
    const fr = new FileReader();
    fr.onload = () => ok(fr.result);
    fr.onerror = () => no(fr.error);
    fr.readAsDataURL(blob);
  });

  const stage = STAGE_ID ? await one('stages', STAGE_ID) : (await all('stages'))[0];
  if (!stage) { console.error('No stage found'); return; }
  const scenes = (await all('scenes', stage.id, 'stageId')).sort((a, b) => a.order - b.order);
  const generatedAgents = await all('generatedAgents', stage.id, 'stageId');
  const mediaFiles = await all('mediaFiles', stage.id, 'stageId');

  const audioIds = new Set();
  for (const s of scenes) for (const a of s.actions ?? []) {
    if (a.type === 'speech' && a.audioId) audioIds.add(a.audioId);
  }
  const audioRecords = [];
  for (const id of audioIds) { const r = await one('audioFiles', id); if (r) audioRecords.push(r); }

  const agents = (generatedAgents.length ? generatedAgents : stage.generatedAgentConfigs || [])
    .map(a => ({ name: a.name, role: a.role, persona: a.persona, avatar: a.avatar, color: a.color, priority: a.priority }));
  const agentIdToIndex = new Map();
  (generatedAgents.length ? generatedAgents : stage.generatedAgentConfigs || [])
    .forEach((a, i) => agentIdToIndex.set(a.id, i));
  const audioIdToPath = new Map(audioRecords.map(r => [r.id, `audio/${r.id}.${r.format || 'mp3'}`]));

  const manifestScenes = scenes.map(s => ({
    type: s.type, title: s.title, order: s.order, content: s.content,
    actions: (s.actions || []).map(a => {
      if (a.type === 'speech') {
        const { audioId, ...rest } = a;
        const audioRef = audioId ? audioIdToPath.get(audioId) : undefined;
        return { ...rest, ...(audioRef ? { audioRef } : {}) };
      }
      return a;
    }),
    whiteboards: s.whiteboards,
    ...(s.multiAgent?.enabled
      ? { multiAgent: { enabled: true, agentIndices: (s.multiAgent.agentIds || []).map(id => agentIdToIndex.get(id)).filter(i => i !== undefined), directorPrompt: s.multiAgent.directorPrompt } }
      : {}),
  }));

  const mediaIndex = {};
  for (const r of audioRecords) mediaIndex[audioIdToPath.get(r.id)] = { type: 'audio', format: r.format, duration: r.duration, voice: r.voice };
  for (const m of mediaFiles) {
    const elementId = m.id.includes(':') ? m.id.split(':').slice(1).join(':') : m.id;
    const ext = m.mimeType?.split('/')[1] || 'jpg';
    mediaIndex[`media/${elementId}.${ext}`] = { type: 'generated', mimeType: m.mimeType, size: m.size, prompt: m.prompt };
  }

  console.log(`Encoding ${audioRecords.length} audio + ${mediaFiles.length} media blobs as base64…`);
  const _embeddedAudio = {};
  for (const r of audioRecords) _embeddedAudio[audioIdToPath.get(r.id)] = await b64(r.blob);
  const _embeddedMedia = {};
  for (const m of mediaFiles) {
    const elementId = m.id.includes(':') ? m.id.split(':').slice(1).join(':') : m.id;
    const ext = m.mimeType?.split('/')[1] || 'jpg';
    _embeddedMedia[`media/${elementId}.${ext}`] = await b64(m.blob);
    if (m.poster) _embeddedMedia[`media/${elementId}.poster.jpg`] = await b64(m.poster);
  }

  const manifest = {
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    appVersion: '0.1.1-console-snippet',
    stage: { name: stage.name, description: stage.description, language: stage.languageDirective, style: stage.style, createdAt: stage.createdAt, updatedAt: stage.updatedAt },
    agents, scenes: manifestScenes, mediaIndex,
    _embeddedAudio, _embeddedMedia,
  };

  const safeName = (stage.name || 'classroom').replace(/[\\/:*?"<>|]/g, '_') || 'classroom';
  const blob = new Blob([JSON.stringify(manifest)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${safeName}.classroom.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  console.log(`Exported "${stage.name}" — ${scenes.length} scenes, ${audioRecords.length} audio, ${mediaFiles.length} media → ${a.download} (${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
})();
```

The snippet runs entirely read-only against OpenMAIC's IndexedDB and touches zero OpenMAIC code. The output filename ends in `.classroom.json`. Upload it to this UI — same Local Export panel, the file-picker accepts both `.maic.zip` and `.classroom.json`.

### Automation mode (secondary, backend-driven)

For webhooks, cron jobs, or any programmatic caller: submit `{classroomId: "..."}` to the backend. It pulls the classroom from OpenMAIC over the internal Docker network, generates the ZIP, and (optionally) POSTs a webhook when done. This is the "server-to-server" path; the heavy data never leaves the server rack.

## Security — localhost only by default

The UI binds to `127.0.0.1:5000:80` in `docker-compose.yml`, meaning it's reachable **only from the host machine** that runs `docker compose`. That's deliberate: nginx injects the exporter's bearer token into every `/api/*` request, so anyone who can reach the UI port effectively has the token. Keeping the port on localhost makes it trivially safe in single-user dev — nothing on the LAN can hit it.

### Exposing to a LAN or the internet

1. Create a gitignored `docker-compose.override.yml` at the repo root:
   ```yaml
   services:
     ui:
       ports: ["5000:80"]   # remove the 127.0.0.1 bind
   ```
2. **Add HTTP basic auth on nginx** — otherwise you've built an open proxy to the exporter. Simplest recipe:
   ```bash
   # On your host, generate an htpasswd file and copy it into the UI public dir
   htpasswd -Bc services/ui/.htpasswd yourusername
   ```
   ...and add to `nginx.conf.template`:
   ```nginx
   auth_basic "Exporter UI";
   auth_basic_user_file /etc/nginx/.htpasswd;
   ```
   (Bundle the file via an extra Dockerfile `COPY` when going this route.)
3. Better still: put it behind a zero-trust tunnel (Netbird, Tailscale, Cloudflare Tunnel).

## Local dev

```bash
# From the repo root, with the exporter already running:
docker compose up -d --build ui

# Open in your browser
xdg-open http://127.0.0.1:5000/   # Linux
open http://127.0.0.1:5000/       # macOS
```

For iterating on HTML/JS/CSS without rebuilds, you can mount `./public` as a volume in a `docker-compose.override.yml`:
```yaml
services:
  ui:
    volumes:
      - ./services/ui/public:/usr/share/nginx/html:ro
```

## Image tagging

The compose file parameterizes the image tag:
```yaml
image: openmaic-exporter-ui:${IMAGE_TAG:-latest}
```
so your CI can stamp commit SHAs or semvers on every build. Local dev defaults to `:latest`. Rollback via `IMAGE_TAG=<old-sha> docker compose up -d`.

## Architecture notes

- No build step — vanilla HTML/JS/CSS served statically by nginx.
- JSZip is vendored (not CDN-loaded) at `public/vendor/jszip.min.js` for offline + pinned-version reliability.
- Browser-side exporters (`public/exporters/scorm1_2.js`, `public/exporters/html.js`) are manual ES-module ports of the backend's TypeScript exporters. A **parity test** in the exporter's test suite guards against drift by generating a ZIP from both sides against the same fixture and diffing the unpacked contents.
- The nginx `location ~` regex block for downloads uses `proxy_pass ${EXPORTER_BASE_URL}$uri;` — the explicit `$uri` is required because bare `proxy_pass` in a regex location ignores internal rewrites.
- See the exporter's own README for the backend-side details.
