# @openmaic/exporter

Content export sidecar for OpenMAIC classrooms. Packages classroom data into LMS-ready formats and serves them via an async HTTP API. Runs alongside OpenMAIC — **zero changes to OpenMAIC's native code**, it just pulls classroom data over HTTP.

## Formats

| Format | Status | Notes |
|---|---|---|
| **SCORM 1.2** | ✅ v1 | Slides-only HTML. Audio/quiz-score wiring planned for v2. |
| SCORM 2004 | planned | |
| xAPI / cmi5 | planned | |
| H5P | planned | |

New formats drop in as sibling plugins under `src/exporters/<format>/` implementing the `ContentExporter` interface — no changes to the core framework.

## Quick start

### 1. Set an auth token

In your OpenMAIC repo's `.env.local`:
```bash
EXPORTER_AUTH_TOKEN=$(openssl rand -hex 32)
```

### 2. Start

```bash
docker compose up -d --build exporter
```

Compose waits for OpenMAIC's healthcheck to pass before starting the exporter. First boot takes ~30s.

### 3. Export a classroom (pull by ID)

Works for classrooms that OpenMAIC has server-persisted (those created via `POST /api/classroom` or the async `generate-classroom` job flow).

```bash
export TOK="$EXPORTER_AUTH_TOKEN"

JOB=$(curl -sSf -X POST http://localhost:4000/export/scorm1.2 \
  -H "Authorization: Bearer $TOK" \
  -H "Content-Type: application/json" \
  -d '{"classroomId":"FYZ7yiAFyy"}' | jq -r .jobId)

# poll until terminal
until S=$(curl -sSf http://localhost:4000/export/jobs/$JOB \
  -H "Authorization: Bearer $TOK" | jq -r .status); \
  [ "$S" = done ] || [ "$S" = failed ] && break; sleep 2; done

curl -sSf http://localhost:4000/export/jobs/$JOB/download \
  -H "Authorization: Bearer $TOK" \
  -o classroom.zip

unzip -l classroom.zip
```

### 4. IndexedDB-only classrooms? Use the UI, not this API.

If step 3 returns `404 classroom not found`, the classroom lives only in the browser's
IndexedDB (OpenMAIC's default for UI-generated classrooms). This API is **pull-mode only** —
it can't reach browser storage. Two options:

1. **Use the exporter UI** at `http://127.0.0.1:5000/` — it runs the export entirely in the
   browser, no network round-trip needed. Upload your `classroom.json` there.
2. Generate via `POST /api/generate-classroom` instead, which persists the classroom to disk
   server-side and makes it reachable via `classroomId`.

### 5. Webhook (skip polling)

Attach a `webhookUrl` and you'll get a POST to it when the job finishes:

```bash
curl -sSf -X POST http://localhost:4000/export/scorm1.2 \
  -H "Authorization: Bearer $TOK" \
  -d '{
    "classroomId":"FYZ7yiAFyy",
    "webhookUrl":"https://your.server/hooks/export"
  }'
```

Webhook payload:
```json
{
  "jobId": "…",
  "status": "done",
  "downloadUrl": "http://exporter:4000/export/jobs/…/download",
  "error": null
}
```

Retries 3× with exponential backoff (1s, 4s, 16s). **Non-blocking**: webhook failure does NOT fail the job — polling remains as backup.

## API

All non-`/health` routes require `Authorization: Bearer <token>`.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/export/:format` | Start a pull-mode export. Body: `{classroomId, webhookUrl?}`. Returns `202 {jobId}`. |
| `GET` | `/formats` | List available export formats. `{formats:[{id, name}]}`. |
| `GET` | `/export/jobs?limit=N` | Recent jobs (newest first), default `limit=50`. |
| `GET` | `/export/jobs/:id` | Job status. `{id, status, format, error?, ...}`. |
| `GET` | `/export/jobs/:id/download` | Stream the ZIP. `200 application/zip` when done, `409` if not yet done, `410` if expired. |
| `GET` | `/health` | Unauthenticated. For Docker healthcheck. |
| `GET` | `/metrics` | Prometheus format. Authenticated. |

Errors are structured:
```json
{"error":"validation_failed","issues":[{"path":["classroom","scenes",0,"id"],"message":"Required"}]}
```

## Environment

| Variable | Default | Description |
|---|---|---|
| `EXPORTER_AUTH_TOKEN` | **required** | Bearer token for all auth-gated routes. Service refuses to start if unset. |
| `OPENMAIC_BASE_URL` | `http://openmaic:3000` | OpenMAIC API endpoint (for pull mode). |
| `JOB_TTL_HOURS` | `24` | How long completed/failed jobs + their ZIPs are retained. |
| `WORKER_CONCURRENCY` | `2` | Number of export jobs processed in parallel. |
| `SHUTDOWN_GRACE_MS` | `30000` | Grace period for in-flight jobs on SIGTERM before abandonment. |
| `DATA_DIR` | `/data` | Where SQLite (`$DATA_DIR/jobs.db`) + ZIPs (`$DATA_DIR/exports/`) live. |
| `JOB_STORE_DRIVER` | `sqlite` | `sqlite` only in v1. Future: `postgres`, `redis`. |
| `EXPORT_STORAGE_DRIVER` | `local` | `local` only in v1. Future: `s3`, `minio`. |
| `LOG_LEVEL` | `info` | Fastify logger level (`trace`, `debug`, `info`, `warn`, `error`). |

## Metrics

`GET /metrics` exposes Prometheus text format. Namespaced `exporter_*` plus default Node process metrics via `prom-client`.

Key series:
- `exporter_jobs_{pending,running}` — queue depth + in-flight concurrency (gauge)
- `exporter_jobs_completed_total{format}` / `exporter_jobs_failed_total{format,reason}` — throughput and error rate
- `exporter_jobs_cleaned_total`, `exporter_jobs_abandoned_total` — TTL sweep + shutdown stragglers
- `exporter_export_duration_seconds{format}` — latency histogram
- `exporter_webhook_attempts_total{result}` — webhook success/failure rate
- `exporter_validation_errors_total{route}` — bad-input rate
- `exporter_storage_bytes` — on-disk footprint

Suggested Grafana queries:
```promql
# p95 export latency by format
histogram_quantile(0.95, sum by (format, le) (rate(exporter_export_duration_seconds_bucket[5m])))

# Error rate
sum(rate(exporter_jobs_failed_total[5m])) / sum(rate(exporter_jobs_completed_total[5m]) + rate(exporter_jobs_failed_total[5m]))

# Queue depth
exporter_jobs_pending
```

Scrape config (Prometheus `prometheus.yml`):
```yaml
scrape_configs:
  - job_name: openmaic-exporter
    scrape_interval: 15s
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials: ${EXPORTER_AUTH_TOKEN}
    static_configs:
      - targets: ['exporter:4000']
```

## Architecture

- **Plugin registry.** Formats live under `src/exporters/<id>/` and implement `ContentExporter`. Registered in `src/exporters/registry.ts`.
- **Pluggable persistence.** `JobStore` (state) and `ExportStorage` (blob) are interfaces. Day-1 impls: SQLite + local disk. Swap via env to Postgres/S3/Redis later without touching callers.
- **Stream-first.** Exporter produces a `Readable`; storage consumes/produces `Readable`; HTTP download pipes directly. No in-memory ZIP buffer.
- **Graceful shutdown.** SIGTERM/SIGINT → stop Fastify → drain workers (up to `SHUTDOWN_GRACE_MS`) → mark stragglers failed → `db.close()` → exit.
- **TTL sweep.** Hourly worker deletes jobs older than `JOB_TTL_HOURS` along with their stored ZIPs.
- **Fail-closed auth.** No token set → service refuses to start. Port is internal to the compose network by default.

## Development

```bash
cd services/exporter
pnpm install
pnpm dev         # tsx watch
pnpm test        # vitest run
pnpm typecheck   # tsc --noEmit
```

Run local with a test token and OpenMAIC on host:
```bash
EXPORTER_AUTH_TOKEN=test DATA_DIR=./tmp OPENMAIC_BASE_URL=http://localhost:3000 pnpm dev
```

## Troubleshooting

**`classroom not found` when using `classroomId`.** The classroom lives only in browser IndexedDB (UI-generated classrooms don't auto-persist server-side). Use the exporter UI at `http://127.0.0.1:5000/` for a browser-local export, or generate the classroom via `POST /api/generate-classroom` which persists to disk.

**Service won't start with "EXPORTER_AUTH_TOKEN must be set".** Add it to your repo's `.env.local`: `EXPORTER_AUTH_TOKEN=$(openssl rand -hex 32)`, then `docker compose up -d exporter` again.

**413 Payload Too Large.** Pull-mode request bodies are tiny (just `{classroomId, webhookUrl?}`); if you see 413 it means something's sending push-shape bodies to this API. That path was retired — use the UI instead (see step 4).

**Exports stuck in `running` forever.** A previous shutdown didn't drain cleanly. Restart the service — the shutdown handler now marks orphan `running` jobs as failed, and you can re-submit.

## License

AGPL-3.0 — matches OpenMAIC.
