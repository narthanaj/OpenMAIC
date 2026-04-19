import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { buildServer, shutdown, type BuiltServer } from '@/server.js';
import type { Config } from '@/config.js';

// End-to-end: build the service in-process, mock OpenMAIC's /api/classroom response
// with undici MockAgent, POST a pull-mode export, poll until done, download the
// ZIP, unzip, and assert its structure.

const FIXTURE_CLASSROOM = {
  id: 'cls_fixture',
  stage: {
    id: 'stg_fixture',
    name: 'Integration Test Classroom',
    description: 'spun up by e2e test',
    language: 'en',
  },
  scenes: [
    { id: 's1', order: 0, title: 'Welcome', actions: [{ type: 'speech', id: 'sp1', text: 'Hello.' }] },
    { id: 's2', order: 1, title: 'Wrap up', actions: [{ type: 'speech', id: 'sp2', text: 'Goodbye.' }] },
  ],
};

describe('exporter e2e', () => {
  let dir: string;
  let built: BuiltServer;
  let agent: MockAgent;
  let prevDispatcher: Dispatcher;
  let baseConfig: Config;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'exporter-e2e-'));
    prevDispatcher = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    // Allow localhost through so Fastify's inject() works without going over the
    // real network — but inject() skips the dispatcher entirely, so this line is
    // mostly defensive. disableNetConnect keeps any unexpected fetch from slipping out.
    setGlobalDispatcher(agent);

    baseConfig = {
      EXPORTER_AUTH_TOKEN: 'test-token-with-sufficient-length',
      OPENMAIC_BASE_URL: 'http://openmaic.test',
      JOB_TTL_HOURS: 24,
      WORKER_CONCURRENCY: 1,
      // FASTIFY_BODY_LIMIT_BYTES removed — push mode is gone; default Fastify limit (1 MB) applies.
      SHUTDOWN_GRACE_MS: 5_000,
      CLEANUP_INTERVAL_MS: 60_000,
      DATA_DIR: dir,
      JOB_STORE_DRIVER: 'sqlite',
      EXPORT_STORAGE_DRIVER: 'local',
      LOG_LEVEL: 'warn',
      PORT: 4000,
      HOST: '127.0.0.1',
    };
    built = buildServer(baseConfig);
    built.workers.start();
  });

  afterEach(async () => {
    await shutdown(built, 'test-cleanup');
    setGlobalDispatcher(prevDispatcher);
    await agent.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('POST → poll → download → valid SCORM ZIP (pull mode)', async () => {
    // Stub OpenMAIC's classroom API.
    agent
      .get('http://openmaic.test')
      .intercept({ path: `/api/classroom?id=${FIXTURE_CLASSROOM.id}`, method: 'GET' })
      .reply(200, { success: true, data: { classroom: FIXTURE_CLASSROOM } });

    // Submit the job.
    const submit = await built.app.inject({
      method: 'POST',
      url: '/export/scorm1.2',
      headers: {
        authorization: 'Bearer test-token-with-sufficient-length',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ classroomId: FIXTURE_CLASSROOM.id }),
    });
    expect(submit.statusCode).toBe(202);
    const { jobId } = submit.json() as { jobId: string };
    expect(jobId).toBeTruthy();

    // Poll until done or 10s.
    const started = Date.now();
    let status = 'pending';
    while (Date.now() - started < 10_000) {
      const poll = await built.app.inject({
        method: 'GET',
        url: `/export/jobs/${jobId}`,
        headers: { authorization: 'Bearer test-token-with-sufficient-length' },
      });
      expect(poll.statusCode).toBe(200);
      status = (poll.json() as { status: string }).status;
      if (status === 'done' || status === 'failed') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(status).toBe('done');

    // Download the ZIP.
    const download = await built.app.inject({
      method: 'GET',
      url: `/export/jobs/${jobId}/download`,
      headers: { authorization: 'Bearer test-token-with-sufficient-length' },
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toBe('application/zip');

    const zip = await JSZip.loadAsync(download.rawPayload);
    const manifest = await zip.file('imsmanifest.xml')?.async('string');
    expect(manifest).toMatch(/<manifest[^>]*version="1.2"/);
    expect(await zip.file('scenes/001.html')?.async('string')).toMatch(/Welcome/);
    expect(await zip.file('scenes/002.html')?.async('string')).toMatch(/Wrap up/);
  });

  it('push-shape bodies are now rejected (schema is pull-only + .strict())', async () => {
    // The UI moved to local-first browser-side zipping, so `{classroom: {...}}`
    // bodies are no longer a valid input. Schema is .strict() → unknown fields
    // like `classroom` cause a 400.
    const pushShape = {
      classroom: {
        id: 'x',
        stage: { id: 's', name: 'legitimate' },
        scenes: [{ id: 'sc1', order: 0, actions: [] }],
      },
    };
    const res = await built.app.inject({
      method: 'POST',
      url: '/export/scorm1.2',
      headers: {
        authorization: 'Bearer test-token-with-sufficient-length',
        'content-type': 'application/json',
      },
      payload: JSON.stringify(pushShape),
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; issues: unknown[] };
    expect(body.error).toBe('validation_failed');
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it('GET /formats lists registered exporters', async () => {
    const res = await built.app.inject({
      method: 'GET',
      url: '/formats',
      headers: { authorization: 'Bearer test-token-with-sufficient-length' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { formats: Array<{ id: string; name: string }> };
    expect(body.formats.map((f) => f.id).sort()).toEqual(['html', 'scorm1.2']);
  });

  it('GET /export/jobs returns recent jobs with a default limit', async () => {
    const res = await built.app.inject({
      method: 'GET',
      url: '/export/jobs',
      headers: { authorization: 'Bearer test-token-with-sufficient-length' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { jobs: unknown[] };
    expect(Array.isArray(body.jobs)).toBe(true);
  });

  it('trailing slash tolerance: /health and /health/ both 200', async () => {
    const noSlash = await built.app.inject({ method: 'GET', url: '/health' });
    const withSlash = await built.app.inject({ method: 'GET', url: '/health/' });
    expect(noSlash.statusCode).toBe(200);
    expect(withSlash.statusCode).toBe(200);
  });

  it('rejects requests missing Authorization with 401', async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: '/export/scorm1.2',
      payload: JSON.stringify({ classroomId: 'anything' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('allows /health without auth', async () => {
    const res = await built.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });

  it('returns 404 for unknown format', async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: '/export/made-up-format',
      headers: {
        authorization: 'Bearer test-token-with-sufficient-length',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ classroomId: 'x' }),
    });
    expect(res.statusCode).toBe(404);
  });
});
