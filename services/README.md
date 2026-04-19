# services/

Sidecar services that run alongside OpenMAIC. Everything under here is **additive**
to the main OpenMAIC repo — each service has its own Dockerfile, its own `package.json`
(when applicable), and lives on the internal Docker Compose network so it can talk to
OpenMAIC without touching OpenMAIC's own code.

## Layout

| Directory | What it does |
|---|---|
| [`exporter/`](./exporter/README.md) | Fastify-based content-export sidecar. Takes a classroom (by ID, pulled from OpenMAIC over the internal network) and produces SCORM 1.2 / static HTML ZIPs. Job queue, TTL sweep, webhook notifications, Prometheus metrics, graceful shutdown. Plugin architecture — adding SCORM 2004 / xAPI / cmi5 / H5P is a new file under `src/exporters/`. |
| [`ui/`](./ui/README.md) | Static-HTML + nginx web UI for the exporter. Two panels: **Local export** (runs entirely in the browser — parses the classroom JSON, builds the ZIP with JSZip, triggers a native download — zero network) and **Automation mode** (backend pull-mode for webhooks/cron, via the exporter API). Auth-injecting reverse proxy; bound to `127.0.0.1:5000` by default. |

## How they connect

```
┌─────────┐  127.0.0.1:5000  ┌────────────┐  :4000 (internal)  ┌──────────────┐  :3000 (internal)  ┌──────────────┐
│ browser │ ────────────────▶│     ui     │ ─────────────────▶│   exporter   │ ──────────────────▶│   openmaic   │
└─────────┘                  └────────────┘                    └──────────────┘                     └──────────────┘
                             auth-injecting                    pull-mode API                        (unchanged)
                             reverse proxy                     job queue + SQLite                   Next.js app
```

- The UI is the human-facing entrypoint.
- The exporter handles server-to-server automation (webhooks, cron, OpenClaw skill).
- OpenMAIC's own code is untouched — exporter just reads from its existing `GET /api/classroom?id=...` endpoint.

## Running

Everything is wired into the root `docker-compose.yml`. From the repo root:

```bash
# Prerequisite: auth token in .env.local (one-time)
echo "EXPORTER_AUTH_TOKEN=$(openssl rand -hex 32)" >> .env.local

# Bring everything up
docker compose up -d

# Open the UI (localhost-only by default)
xdg-open http://127.0.0.1:5000/
```

See each service's `README.md` for per-service details (env vars, API surface, metrics, security posture, troubleshooting).

## Design notes

- **Separation of concerns.** The UI service doesn't contain any business logic — it's an nginx proxy + static files. All export logic lives in the exporter's code (TypeScript) and the UI's browser-side JS ports (both covered by a **parity test** that keeps them in lockstep).
- **Local-first for user-interactive work.** The UI uploads nothing over the network — a 40 MB classroom parses + zips + downloads in ~1.5 s, entirely client-side. The backend only handles programmatic callers where bytes need to stay in the data center.
- **Pluggable backends.** `JobStore` and `ExportStorage` are interfaces with SQLite + local-disk implementations for v1. Swap to Postgres / Redis / S3 / MinIO via env-var driver selection without changing callers.
- **Observability by default.** `/metrics` Prometheus endpoint, structured pino logs, OpenTelemetry-compatible error classes. Healthchecks on both services so Compose's `depends_on: condition: service_healthy` does the right thing.

## Adding a new export format

1. Create `exporter/src/exporters/<format>/` implementing `ContentExporter` (see `scorm1_2/index.ts` for a reference).
2. Register it in `exporter/src/exporters/registry.ts`.
3. Mirror the logic in `ui/public/exporters/<format>.js` (browser-safe ES module; no Node APIs).
4. Add the format to the parity test's format list in `exporter/tests/unit/exporter-parity.test.ts`.
5. Tests: `cd services/exporter && pnpm test` — the parity test verifies backend and browser produce the same content.

No wiring changes needed in the UI, routes, metrics, or compose — the plugin discovery at startup picks up the new format automatically.
