import { describe, expect, it } from 'vitest';
import {
  classifyUpstreamError,
  apiErrorFromUpstream,
} from '@/lib/server/upstream-error';

// AI_APICallError is the shape the Vercel AI SDK throws. We duck-type-detect it,
// so fixtures here are plain objects — no need to import the real class.
function aiApiCallError(status: number, message: string, body?: unknown) {
  const e = new Error(message) as Error & Record<string, unknown>;
  e.name = 'AI_APICallError';
  e.statusCode = status;
  e.responseBody = body;
  return e;
}

function networkError(code: string, message: string) {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

describe('classifyUpstreamError', () => {
  it('maps Vercel AI SDK 401 to UPSTREAM_AUTH', () => {
    const r = classifyUpstreamError(aiApiCallError(401, 'Incorrect API key'));
    expect(r.status).toBe(401);
    expect(r.code).toBe('UPSTREAM_AUTH');
    expect(r.upstreamStatus).toBe(401);
    expect(r.retryable).toBe(false);
  });

  it('maps Vercel AI SDK 429 to UPSTREAM_RATE_LIMIT and forwards Retry-After', () => {
    const err = aiApiCallError(429, 'Rate limited') as Error & Record<string, unknown>;
    err.responseHeaders = { 'retry-after': '42' };
    const r = classifyUpstreamError(err);
    expect(r.status).toBe(429);
    expect(r.code).toBe('UPSTREAM_RATE_LIMIT');
    expect(r.retryAfterSeconds).toBe(42);
    expect(r.retryable).toBe(true);
  });

  it('maps Vercel AI SDK 5xx to UPSTREAM_UNAVAILABLE', () => {
    const r = classifyUpstreamError(aiApiCallError(503, 'Upstream down'));
    expect(r.status).toBe(503);
    expect(r.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(r.retryable).toBe(true);
  });

  it('maps MiniMax base_resp 2049 (invalid api key) to 401 UPSTREAM_AUTH', () => {
    const err = new Error(
      'MiniMax TTS error: No audio returned. Response: {"base_resp":{"status_code":2049,"status_msg":"invalid api key"}}',
    );
    const r = classifyUpstreamError(err);
    expect(r.status).toBe(401);
    expect(r.code).toBe('UPSTREAM_AUTH');
    expect(r.upstreamCode).toBe(2049);
  });

  it('maps MiniMax base_resp 1039 (rate limit) to 429', () => {
    const err = new Error(
      'MiniMax error: {"base_resp":{"status_code":1039,"status_msg":"rate limited"}}',
    );
    const r = classifyUpstreamError(err);
    expect(r.status).toBe(429);
    expect(r.code).toBe('UPSTREAM_RATE_LIMIT');
  });

  it('maps Node ECONNREFUSED to 502 UPSTREAM_UNAVAILABLE', () => {
    const r = classifyUpstreamError(networkError('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:9999'));
    expect(r.status).toBe(502);
    expect(r.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(r.retryable).toBe(true);
  });

  it('maps Node ETIMEDOUT to 504 UPSTREAM_TIMEOUT', () => {
    const r = classifyUpstreamError(networkError('ETIMEDOUT', 'timed out'));
    expect(r.status).toBe(504);
    expect(r.code).toBe('UPSTREAM_TIMEOUT');
  });

  it('falls back to network match by message when err.code absent', () => {
    const r = classifyUpstreamError(new Error('getaddrinfo ENOTFOUND api.example.com'));
    expect(r.status).toBe(502);
    expect(r.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('maps AbortError to 499 CLIENT_CLOSED_REQUEST', () => {
    const e = new Error('aborted') as Error;
    e.name = 'AbortError';
    const r = classifyUpstreamError(e);
    expect(r.status).toBe(499);
    expect(r.code).toBe('CLIENT_CLOSED_REQUEST');
  });

  it('text-pattern fallback: OpenAI "Incorrect API key" string → 401', () => {
    const r = classifyUpstreamError(
      new Error('Incorrect API key provided: AQ.Ab8***zMGw. See https://platform.openai.com/...'),
    );
    expect(r.status).toBe(401);
    expect(r.code).toBe('UPSTREAM_AUTH');
  });

  it('text-pattern fallback: "model not found" → 404', () => {
    const r = classifyUpstreamError(new Error('model gpt-5.2 does not exist'));
    expect(r.status).toBe(404);
    expect(r.code).toBe('UPSTREAM_NOT_FOUND');
  });

  it('unknown error falls through to 500 INTERNAL_ERROR', () => {
    const r = classifyUpstreamError(new Error('something truly weird'));
    expect(r.status).toBe(500);
    expect(r.code).toBe('INTERNAL_ERROR');
  });

  it('non-Error object is stringified', () => {
    const r = classifyUpstreamError({ weird: 'payload' });
    expect(r.status).toBe(500);
    expect(typeof r.message).toBe('string');
  });
});

describe('apiErrorFromUpstream', () => {
  it('overrides INTERNAL_ERROR with provided defaultCode', async () => {
    const res = apiErrorFromUpstream(new Error('mystery'), { defaultCode: 'GENERATION_FAILED' });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.errorCode).toBe('GENERATION_FAILED');
  });

  it('does NOT override when classifier already chose a semantic code', async () => {
    const res = apiErrorFromUpstream(aiApiCallError(429, 'rate limited'), {
      defaultCode: 'GENERATION_FAILED',
    });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.errorCode).toBe('UPSTREAM_RATE_LIMIT');
  });

  it('forwards upstreamStatus and sets Retry-After header when available', async () => {
    const err = aiApiCallError(429, 'rate limited') as Error & Record<string, unknown>;
    err.responseHeaders = { 'retry-after': '7' };
    const res = apiErrorFromUpstream(err);
    expect(res.headers.get('retry-after')).toBe('7');
    const body = await res.json();
    expect(body.upstreamStatus).toBe(429);
    expect(body.retryable).toBe(true);
  });
});
