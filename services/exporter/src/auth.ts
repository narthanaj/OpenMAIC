import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

// Bearer-token preHandler. Registered as a global hook; individual routes opt OUT
// via `(req as AuthAwareRequest).skipAuth = true` in their handler config (we use
// the `/health` route this way so Docker healthchecks don't need the secret).
//
// Compared to plain string comparison, `timingSafeEqual` prevents the token-leak
// variant where an attacker times early-fail paths on incorrect-prefix guesses.

export interface AuthOptions {
  token: string;
  // Route URL paths that do NOT require auth. Matched exact (minus query string).
  unauthenticated?: string[];
}

export function installAuth(app: FastifyInstance, opts: AuthOptions): void {
  const unauth = new Set(opts.unauthenticated ?? ['/health']);
  const expected = Buffer.from(opts.token, 'utf8');

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    // Strip query string AND normalize trailing slash so /health and /health/
    // both resolve to the same unauthenticated path (matches Fastify's
    // `ignoreTrailingSlash: true` routing behavior, which applies AFTER
    // preHandler runs).
    const rawPath = req.url.split('?')[0] ?? '';
    const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, '') : rawPath;
    if (unauth.has(path)) return;

    const header = req.headers.authorization;
    if (!header || typeof header !== 'string' || !header.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'unauthorized', detail: 'missing or malformed Authorization header' });
    }
    const given = Buffer.from(header.slice('Bearer '.length), 'utf8');
    // timingSafeEqual rejects unequal-length inputs outright. We must pad to expected
    // length or compare twice with length-check first. Length-check-first is cheaper
    // and doesn't leak token length (tokens are fixed-length in practice).
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return reply.code(401).send({ error: 'unauthorized', detail: 'invalid token' });
    }
  });
}
