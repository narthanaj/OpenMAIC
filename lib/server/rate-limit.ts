import type { NextRequest } from 'next/server';
import type { NextResponse } from 'next/server';
import { apiError, type ApiErrorBody } from './api-response';

// In-memory sliding-window rate limiter. Intentional limitations:
//   - Single-process only. If OpenMAIC ever runs >1 replica, swap this module's implementation for
//     a Redis-backed bucket (e.g. @upstash/ratelimit). The public signature is designed to let that
//     happen without touching any route handler.
//   - Volatile: a container restart resets the counters. Acceptable here because the goal is
//     *abuse prevention against paid APIs*, not SLO-grade fairness.

export type RateLimitBucket =
  | 'chat'
  | 'tts'
  | 'generate' // expensive classroom/scene generation
  | 'verify' // provider verification (cheap but cred-sensitive)
  | 'transcription'
  | 'web_search'
  | 'media'; // image/video generation

interface BucketDefaults {
  limit: number;
  windowMs: number;
}

// Defaults chosen by category: TTS runs in parallel (per speech action) so it needs the highest
// per-minute ceiling; classroom generation is a one-shot heavy job so it gets a long window.
const DEFAULTS: Record<RateLimitBucket, BucketDefaults> = {
  chat: { limit: 20, windowMs: 60_000 },
  tts: { limit: 60, windowMs: 60_000 },
  generate: { limit: 3, windowMs: 5 * 60_000 },
  verify: { limit: 30, windowMs: 60_000 },
  transcription: { limit: 20, windowMs: 60_000 },
  web_search: { limit: 20, windowMs: 60_000 },
  media: { limit: 20, windowMs: 60_000 },
};

// Stored per `(bucket, identifier)`; each entry is an array of hit timestamps (ms).
// The entries auto-shrink on each read — we trim anything older than `windowMs` before checking.
const store = new Map<string, number[]>();

// Periodic GC to prevent long-lived Maps from growing with keys that never hit again. In a
// small self-hosted deployment this is overkill, but it's cheap and protects against memory leaks.
let lastGc = Date.now();
const GC_INTERVAL_MS = 5 * 60_000;

function maybeGc(now: number): void {
  if (now - lastGc < GC_INTERVAL_MS) return;
  lastGc = now;
  const MAX_WINDOW = 10 * 60_000; // longest bucket window × 2
  for (const [k, v] of store) {
    const latest = v[v.length - 1] ?? 0;
    if (now - latest > MAX_WINDOW) store.delete(k);
  }
}

function envOverride(bucket: RateLimitBucket): BucketDefaults {
  // Example: RATE_LIMIT_TTS_PER_MINUTE=120 overrides the default 60/min bucket.
  const upper = bucket.toUpperCase();
  const perMin = Number(process.env[`RATE_LIMIT_${upper}_PER_MINUTE`]);
  if (Number.isFinite(perMin) && perMin > 0) {
    return { limit: perMin, windowMs: 60_000 };
  }
  return DEFAULTS[bucket];
}

export interface RateLimitResult {
  allowed: boolean;
  bucket: RateLimitBucket;
  identifier: string;
  limit: number;
  remaining: number;
  resetAt: number; // epoch ms when the oldest in-window hit expires
  retryAfterSeconds?: number;
}

// Core check. Caller should early-return a 429 when `allowed === false` — see rateLimitResponse.
export function enforceRateLimit(
  bucket: RateLimitBucket,
  identifier: string,
): RateLimitResult {
  if (process.env.RATE_LIMIT_DISABLED === '1' || process.env.NODE_ENV === 'test') {
    return {
      allowed: true,
      bucket,
      identifier,
      limit: Infinity,
      remaining: Infinity,
      resetAt: Date.now(),
    };
  }
  const { limit, windowMs } = envOverride(bucket);
  const now = Date.now();
  maybeGc(now);
  const key = `${bucket}:${identifier}`;
  const timestamps = store.get(key) ?? [];
  // Drop everything outside the sliding window.
  const fresh = timestamps.filter((t) => now - t < windowMs);

  if (fresh.length >= limit) {
    const oldest = fresh[0];
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    store.set(key, fresh);
    return {
      allowed: false,
      bucket,
      identifier,
      limit,
      remaining: 0,
      resetAt: oldest + windowMs,
      retryAfterSeconds,
    };
  }

  fresh.push(now);
  store.set(key, fresh);
  return {
    allowed: true,
    bucket,
    identifier,
    limit,
    remaining: Math.max(0, limit - fresh.length),
    resetAt: (fresh[0] ?? now) + windowMs,
  };
}

// Produce the 429 response with X-RateLimit-* + Retry-After headers. Route handlers call this
// when `allowed === false` so the shape stays uniform across every route.
export function rateLimitResponse(result: RateLimitResult): NextResponse<ApiErrorBody> {
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(Math.ceil(result.resetAt / 1000)),
  };
  if (result.retryAfterSeconds !== undefined) {
    headers['Retry-After'] = String(result.retryAfterSeconds);
  }
  return apiError('UPSTREAM_RATE_LIMIT', {
    status: 429,
    error: `Rate limit exceeded for ${result.bucket}. Try again in ${result.retryAfterSeconds ?? 60}s.`,
    retryable: true,
    headers,
  });
}

// Best-effort identifier derivation: authenticated sub > first IP in X-Forwarded-For > 'anonymous'.
// Keyed separately per-bucket so a heavy TTS consumer doesn't block chat for the same identifier
// (and vice-versa).
export function getRateLimitIdentifier(req: NextRequest): string {
  // A future auth layer can set `x-openmaic-user`; honour it if present so authenticated users
  // get their own bucket rather than sharing their proxy's X-Forwarded-For.
  const user = req.headers.get('x-openmaic-user');
  if (user) return `user:${user}`;

  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return `ip:${first}`;
  }
  const real = req.headers.get('x-real-ip');
  if (real) return `ip:${real.trim()}`;
  // `NextRequest` does not expose remote address directly; fall through.
  return 'anonymous';
}

// Convenience wrapper for the common "check + 429-on-fail" pattern.
// Returns null when the request is allowed; returns the response to send back when not.
export function applyRateLimit(
  bucket: RateLimitBucket,
  req: NextRequest,
): NextResponse<ApiErrorBody> | null {
  const result = enforceRateLimit(bucket, getRateLimitIdentifier(req));
  if (!result.allowed) return rateLimitResponse(result);
  return null;
}

// Test-only helper — clears the in-memory buckets between runs so tests don't bleed into each other.
export function __resetRateLimitStateForTests(): void {
  store.clear();
  lastGc = Date.now();
}
