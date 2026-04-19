import { request } from 'undici';

// Webhook notifier. Fires a single POST to `webhookUrl` on job terminal state.
// Retries 3 attempts total with exponential backoff (1s, 4s, 16s) on transient
// failures; timeout per attempt is 10s. Non-blocking by contract — webhook failure
// does NOT fail the job — the caller awaits this for logging/metrics only.

export interface WebhookPayload {
  jobId: string;
  status: 'done' | 'failed';
  downloadUrl?: string;
  error?: string | null;
}

export interface WebhookResult {
  ok: boolean;
  attempts: number;
  lastStatus?: number;
  lastError?: string;
}

const DEFAULT_BACKOFFS_MS = [1_000, 4_000, 16_000];
const PER_ATTEMPT_TIMEOUT_MS = 10_000;

export interface WebhookOptions {
  // Override the retry backoff schedule. Useful for tests to skip real waits.
  // Production callers should not override; the default is tuned for typical
  // LMS/webhook-receiver reliability.
  backoffsMs?: readonly number[];
}

function isRetryable(status: number): boolean {
  // Transient server-side or rate-limit failures are worth retrying. Any 4xx other
  // than 408/429 is a config problem on the receiver side — don't burn backoff on it.
  if (status === 408) return true; // request timeout
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

export async function postWebhook(
  url: string,
  payload: WebhookPayload,
  options: WebhookOptions = {},
): Promise<WebhookResult> {
  const BACKOFFS_MS = options.backoffsMs ?? DEFAULT_BACKOFFS_MS;
  let lastStatus: number | undefined;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= BACKOFFS_MS.length + 1; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PER_ATTEMPT_TIMEOUT_MS);
    try {
      const res = await request(url, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      clearTimeout(timer);
      // Drain the response body so the connection can be reused by the pool.
      await res.body.dump();
      lastStatus = res.statusCode;

      if (res.statusCode >= 200 && res.statusCode < 300) {
        return { ok: true, attempts: attempt, lastStatus };
      }
      if (!isRetryable(res.statusCode)) {
        return {
          ok: false,
          attempts: attempt,
          lastStatus,
          lastError: `non-retryable ${res.statusCode}`,
        };
      }
    } catch (err: unknown) {
      clearTimeout(timer);
      lastError = (err as Error)?.message ?? 'unknown error';
      // AbortError = our own timeout; network errors = undici. Both retry-worthy.
    }

    // Backoff before next attempt, if any retries remain. attempt is 1-indexed; the
    // index into BACKOFFS_MS is attempt-1 (no backoff after the final attempt).
    const nextBackoff = BACKOFFS_MS[attempt - 1];
    if (attempt <= BACKOFFS_MS.length && nextBackoff !== undefined) {
      await new Promise((r) => setTimeout(r, nextBackoff));
    }
  }

  return {
    ok: false,
    attempts: BACKOFFS_MS.length + 1,
    ...(lastStatus !== undefined ? { lastStatus } : {}),
    ...(lastError !== undefined ? { lastError } : {}),
  };
}

// Test-only helper for introspecting the default schedule.
export function defaultBackoffsMs(): readonly number[] {
  return DEFAULT_BACKOFFS_MS;
}
