# @openmaic/exporter-ui

Lightweight web UI for the OpenMAIC content exporter sidecar. Lets you export classrooms to SCORM 1.2 or static HTML without touching the terminal.

## Two modes

### Local export (primary, browser-only)

You upload a `classroom.json` file (or paste it in). The browser parses it, builds the SCORM/HTML package, zips it with JSZip, and triggers a native download — **no network traffic, no backend involvement, works offline**. Sub-second for small classrooms, a few seconds for 40 MB+.

This is the path you want when you have a classroom stored only in the browser's IndexedDB (standard for UI-generated OpenMAIC classrooms).

**Extracting a classroom from OpenMAIC's IndexedDB.** The DB is named `MAIC-Database` (not `openmaic-db`), and classrooms aren't stored in a single store — they're split across a `stages` table (one row per classroom) and a `scenes` table (N rows per classroom, indexed on `stageId`). Clicking through DevTools → Application → IndexedDB is painful because you'd have to reconstruct the join manually. Use this console snippet instead: paste it into DevTools Console on any OpenMAIC page, it assembles the classroom into the shape the exporter expects and downloads a `.json` to `~/Downloads/`:

```js
(async () => {
  const ID = 'YOUR_CLASSROOM_ID';   // change to your id; set to null for the first one

  const db = await new Promise((ok, no) => {
    const r = indexedDB.open('MAIC-Database');
    r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
  });
  const stage = await new Promise((ok, no) => {
    const tx = db.transaction('stages', 'readonly').objectStore('stages');
    const r = ID ? tx.get(ID) : tx.openCursor();
    r.onsuccess = () => ok(ID ? r.result : (r.result?.value ?? null));
    r.onerror = () => no(r.error);
  });
  if (!stage) { console.error('No stage with id', ID); return; }
  const scenes = await new Promise((ok, no) => {
    const r = db.transaction('scenes', 'readonly').objectStore('scenes').index('stageId').getAll(stage.id);
    r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
  });
  const dir = (stage.languageDirective || '').toLowerCase();
  const language =
    /zh-?cn|chinese/.test(dir) ? 'zh-CN' :
    /ja-?jp|japanese/.test(dir) ? 'ja-JP' :
    /ru-?ru|russian/.test(dir) ? 'ru-RU' : 'en';
  const classroom = {
    id: stage.id,
    stage: { id: stage.id, name: stage.name, description: stage.description, language },
    scenes: [...scenes].sort((a, b) => a.order - b.order)
      .map((s) => ({ id: s.id, order: s.order, title: s.title, actions: s.actions || [] })),
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(classroom, null, 2)], { type: 'application/json' }));
  a.download = `${classroom.id}.json`;
  a.click();
  console.log(`Exported "${classroom.stage.name}" — ${classroom.scenes.length} scenes`);
})();
```

Note: this snippet does NOT extract TTS audio blobs from the `audioFiles` table — v1 exporter is slides-only (no audio in the ZIP).

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
