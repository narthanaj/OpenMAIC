import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pipeline } from 'node:stream/promises';
import { knownFormats, getExporter } from '../exporters/registry.js';
import { parseEmbeddedBundle, BundleDecodeError } from '../sources/bundle.js';
import type { Config } from '../config.js';
import * as metrics from '../metrics.js';

// POST /export/:format/from-bundle
//
// Synchronous, stateless variant of /export/:format. Accepts a full embedded
// bundle in the request body (the DevTools snippet's output, or any caller
// that can produce a ClassroomManifest-shaped JSON with _embeddedAudio /
// _embeddedMedia base64 maps), decodes in-memory, runs the exporter, and
// streams the output ZIP back on the same connection.
//
// Why sync instead of enqueuing a Job row? Two reasons:
//   1. No classroomId → the existing worker pool can't reach the data; the
//      payload IS the data.
//   2. One-shot exports don't benefit from the job queue's retry / webhook /
//      TTL machinery. The client already holds the source of truth; if the
//      connection drops mid-response, they re-POST.
//
// Hardening layers (preValidation first, handler second):
//   1. preValidation: Content-Type + Content-Length gating. 415 on anything
//      that isn't application/json, 413 on >100 MB bodies, 400 on suspiciously
//      small bodies (<100 bytes can't be a real manifest). Short-circuits
//      before Fastify buffers 99 MB of garbage into the body parser.
//   2. bodyLimit: 100 MB per-route override. The default /export/:format
//      route keeps its 1 MB limit — only /from-bundle can accept big bodies.
//   3. Decoder: structural validation + MIME cross-check. See bundle.ts.
//   4. Streamed response via stream/promises.pipeline — propagates errors
//      both ways, destroys the source if the client disconnects mid-transfer.

export interface ExportFromBundleDeps {
  config: Config;
}

// Per-route body limit. 100 MB matches the Nginx proxy ceiling on /api/*
// and the DevTools snippet's documented upper bound (classroom + base64
// audio hovers around 40-80 MB in practice; 100 MB is the comfort headroom).
const ROUTE_BODY_LIMIT = 100_000_000;
// Minimum plausible body size. A manifest with zero scenes + zero audio
// still has ~200 bytes of structural JSON; anything under 100 bytes is
// guaranteed garbage or an empty POST.
const MIN_BODY_BYTES = 100;

export async function registerExportFromBundleRoute(
  app: FastifyInstance,
  deps: ExportFromBundleDeps,
): Promise<void> {
  app.post(
    '/export/:format/from-bundle',
    {
      bodyLimit: ROUTE_BODY_LIMIT,
      preValidation: async (req, reply) => {
        // Reject non-JSON bodies before the parser tries them. A 100 MB
        // `text/plain` body would otherwise churn through application/json
        // content-type coercion and trip a confusing error downstream.
        const ct = String(req.headers['content-type'] ?? '').toLowerCase();
        if (!ct.includes('application/json')) {
          return reply.code(415).send({
            error: 'unsupported_media_type',
            expected: 'application/json',
          });
        }
        // Content-Length is advisory (the client can lie), but when set and
        // outside bounds it's free to reject immediately. Saves buffering
        // cost and trivially thwarts a naive DoS attempt.
        const cl = req.headers['content-length'];
        if (cl != null) {
          const size = Number(cl);
          if (Number.isFinite(size)) {
            if (size < MIN_BODY_BYTES) {
              return reply.code(400).send({ error: 'body_too_small' });
            }
            if (size > ROUTE_BODY_LIMIT) {
              return reply.code(413).send({
                error: 'body_too_large',
                maxBytes: ROUTE_BODY_LIMIT,
              });
            }
          }
        }
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { format } = req.params as { format?: string };
      if (!format || !knownFormats().includes(format)) {
        return reply.code(404).send({
          error: 'unknown_format',
          message: `format "${format}" not supported`,
          supported: knownFormats(),
        });
      }

      // Decode + validate. BundleDecodeError carries a structural `code` we
      // map to the response body's `detail`; we never interpolate the raw
      // key, payload, or MIME into an error *message* (the response is a
      // surface, same as logs, that would otherwise leak user-supplied data).
      let bundle;
      try {
        bundle = parseEmbeddedBundle(req.body);
      } catch (err) {
        if (err instanceof BundleDecodeError) {
          metrics.validationErrors.inc({ route: 'export_from_bundle' });
          // `context` is a small dict of enumerable reason keys (bucket,
          // observedMime) — short, safe to echo back. `issues` carries zod
          // path/message pairs which are also structural.
          const body: Record<string, unknown> = {
            error: 'validation_failed',
            detail: err.code,
            ...err.context,
          };
          const issues = (err as BundleDecodeError & { issues?: unknown }).issues;
          if (issues) body.issues = issues;
          return reply.code(400).send(body);
        }
        throw err;
      }

      const exporter = getExporter(format);
      if (!exporter) {
        // Race guard — knownFormats() already covered this above, but the
        // registry could theoretically be hot-reloaded. Fail cleanly.
        return reply.code(404).send({ error: 'unknown_format' });
      }

      const titleSafe = (bundle.classroom.stage.name || 'classroom').replace(/[\\/:*?"<>|]/g, '_');
      const filename = `${titleSafe}.${format.replace(/\./g, '_')}.zip`;

      req.log.info(
        {
          format,
          scenes: bundle.classroom.scenes.length,
          audio: [...bundle.mediaBundle.keys()].filter((k) => k.startsWith('audio/')).length,
          media: [...bundle.mediaBundle.keys()].filter((k) => k.startsWith('media/')).length,
        },
        'from-bundle export starting',
      );

      const zipStream = await exporter.export(bundle.classroom, {
        mediaBundle: bundle.mediaBundle,
      });

      // Hijack to take over the socket — Fastify's auto-send would buffer
      // the whole stream into memory before flushing, defeating the whole
      // point of generateNodeStream(). After hijack, we manage headers +
      // status ourselves via reply.raw.
      //
      // keep-alive signals the server-side 300 s connectionTimeout to
      // compliant clients (curl + axios both honor it) so the client's own
      // default 30–60 s timeout doesn't truncate the transfer.
      reply.hijack();
      reply.raw.setHeader('content-type', 'application/zip');
      reply.raw.setHeader('content-disposition', `attachment; filename="${filename}"`);
      reply.raw.setHeader('keep-alive', 'timeout=300');
      reply.raw.statusCode = 200;

      // Gold-standard stream wiring: pipeline() propagates errors both
      // directions and destroy()s the source cleanly on client disconnect,
      // so a flaky connection mid-stream doesn't leak the ZIP stream's
      // internal buffers for the lifetime of the process.
      try {
        await pipeline(zipStream, reply.raw);
      } catch (err) {
        // Client disconnects land here with ECONNRESET / ERR_STREAM_PREMATURE_CLOSE.
        // Nothing to do but log — the response is already toast.
        req.log.warn({ err }, 'from-bundle stream aborted');
        try {
          reply.raw.destroy();
        } catch {
          /* noop — destroy is best-effort after pipeline already failed */
        }
      }

      // GC nudge after large responses — env-gated (requires --expose-gc to
      // be useful). Runs on `finish` so we don't burn GC time while bytes
      // are still flowing to the client. setImmediate defers one tick so
      // the close-event chain completes first.
      if (deps.config.EXPORTER_GC_ON_RESPONSE && typeof (globalThis as { gc?: () => void }).gc === 'function') {
        reply.raw.on('finish', () => {
          setImmediate(() => {
            try {
              (globalThis as { gc?: () => void }).gc?.();
            } catch {
              /* noop — gc() throws only when flag is missing, which the guard caught */
            }
          });
        });
      }
    },
  );
}
