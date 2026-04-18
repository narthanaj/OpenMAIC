import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import {
  enforceRateLimit,
  rateLimitResponse,
  __resetRateLimitStateForTests,
} from '@/lib/server/rate-limit';

// The module's production guard short-circuits when NODE_ENV === 'test' or RATE_LIMIT_DISABLED === '1'.
// To actually test the limiter we need to force it on.
const originalNodeEnv = process.env.NODE_ENV;
const originalDisabled = process.env.RATE_LIMIT_DISABLED;

beforeEach(() => {
  (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
  process.env.RATE_LIMIT_DISABLED = '0';
  __resetRateLimitStateForTests();
});

afterEach(() => {
  (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
  process.env.RATE_LIMIT_DISABLED = originalDisabled;
});

describe('enforceRateLimit (sliding window)', () => {
  it('allows up to the bucket limit and then denies', () => {
    // verify bucket defaults to 30/min
    for (let i = 0; i < 30; i++) {
      const r = enforceRateLimit('verify', 'ip:1.2.3.4');
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(30 - i - 1);
    }
    const denied = enforceRateLimit('verify', 'ip:1.2.3.4');
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('isolates identifiers (two IPs do not share a bucket)', () => {
    for (let i = 0; i < 20; i++) enforceRateLimit('chat', 'ip:a');
    const aNext = enforceRateLimit('chat', 'ip:a');
    expect(aNext.allowed).toBe(false);
    const bFirst = enforceRateLimit('chat', 'ip:b');
    expect(bFirst.allowed).toBe(true);
  });

  it('isolates buckets (TTS quota does not eat chat quota)', () => {
    // TTS allows 60; exhaust it.
    for (let i = 0; i < 60; i++) {
      const r = enforceRateLimit('tts', 'ip:x');
      expect(r.allowed).toBe(true);
    }
    expect(enforceRateLimit('tts', 'ip:x').allowed).toBe(false);
    // Chat should still have its full 20/min.
    expect(enforceRateLimit('chat', 'ip:x').allowed).toBe(true);
  });

  it('recovers after the window passes (simulated by mocking Date.now)', () => {
    const realNow = Date.now.bind(Date);
    let t = realNow();
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => t);
    try {
      for (let i = 0; i < 20; i++) enforceRateLimit('chat', 'ip:a');
      expect(enforceRateLimit('chat', 'ip:a').allowed).toBe(false);
      t += 61_000; // advance past the 60s window
      expect(enforceRateLimit('chat', 'ip:a').allowed).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('honours RATE_LIMIT_DISABLED=1 short-circuit', () => {
    process.env.RATE_LIMIT_DISABLED = '1';
    for (let i = 0; i < 200; i++) {
      expect(enforceRateLimit('chat', 'ip:y').allowed).toBe(true);
    }
  });

  it('honours env override RATE_LIMIT_CHAT_PER_MINUTE', () => {
    process.env.RATE_LIMIT_CHAT_PER_MINUTE = '3';
    try {
      for (let i = 0; i < 3; i++) {
        expect(enforceRateLimit('chat', 'ip:z').allowed).toBe(true);
      }
      expect(enforceRateLimit('chat', 'ip:z').allowed).toBe(false);
    } finally {
      delete process.env.RATE_LIMIT_CHAT_PER_MINUTE;
    }
  });
});

describe('rateLimitResponse', () => {
  it('returns a 429 with Retry-After and X-RateLimit-* headers', async () => {
    const res = rateLimitResponse({
      allowed: false,
      bucket: 'tts',
      identifier: 'ip:1',
      limit: 60,
      remaining: 0,
      resetAt: Date.now() + 45_000,
      retryAfterSeconds: 45,
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('45');
    expect(res.headers.get('x-ratelimit-limit')).toBe('60');
    expect(res.headers.get('x-ratelimit-remaining')).toBe('0');
    const body = await res.json();
    expect(body.errorCode).toBe('UPSTREAM_RATE_LIMIT');
    expect(body.retryable).toBe(true);
  });
});
