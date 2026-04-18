import {
  apiError,
  type ApiErrorCode,
  type ApiErrorBody,
  API_ERROR_CODES,
} from './api-response';
import type { NextResponse } from 'next/server';

// Shape of what every classifier branch returns. The route handler only cares about these five fields;
// apiErrorFromUpstream below maps it to an HTTP response.
export interface ClassifiedUpstreamError {
  status: number;
  code: ApiErrorCode;
  message: string;
  upstreamStatus?: number;
  upstreamCode?: string | number;
  upstreamDetails?: unknown;
  retryable: boolean;
  // If the upstream told us how long to wait (e.g. 429 Retry-After), forward it. Header name chosen
  // for direct re-serialisation.
  retryAfterSeconds?: number;
}

// Vercel AI SDK wraps provider errors in AI_APICallError. We detect by duck-typing rather than
// `instanceof` so the module doesn't hard-import the SDK (keeps this file tree-shakeable and
// testable without fixtures).
interface AICallErrorLike {
  name?: string;
  statusCode?: number;
  responseBody?: unknown;
  data?: unknown;
  message?: string;
  isRetryable?: boolean;
}
function isAICallError(error: unknown): error is AICallErrorLike {
  if (!error || typeof error !== 'object') return false;
  const e = error as Record<string, unknown>;
  return (
    typeof e.name === 'string' &&
    (e.name === 'AI_APICallError' ||
      e.name === 'APICallError' ||
      (typeof e.statusCode === 'number' && typeof e.message === 'string'))
  );
}

// MiniMax returns HTTP 200 with `{ base_resp: { status_code, status_msg } }`. The TTS provider
// rewraps this into `Error(MiniMax TTS error: ... Response: {...})` — we parse back out.
// Known codes: https://platform.minimaxi.com/document/ApiReference/common/errorCode
const MINIMAX_CODE_MAP: Record<number, { status: number; code: ApiErrorCode }> = {
  1002: { status: 429, code: API_ERROR_CODES.UPSTREAM_RATE_LIMIT },
  1004: { status: 401, code: API_ERROR_CODES.UPSTREAM_AUTH },
  1008: { status: 402, code: API_ERROR_CODES.UPSTREAM_PAYMENT_REQUIRED },
  1013: { status: 400, code: API_ERROR_CODES.INVALID_REQUEST },
  1027: { status: 400, code: API_ERROR_CODES.CONTENT_SENSITIVE },
  1039: { status: 429, code: API_ERROR_CODES.UPSTREAM_RATE_LIMIT },
  2013: { status: 400, code: API_ERROR_CODES.INVALID_REQUEST },
  2049: { status: 401, code: API_ERROR_CODES.UPSTREAM_AUTH },
};

function extractMinimaxStatusCode(message: string): number | null {
  const match = message.match(/"status_code"\s*:\s*(\d+)/);
  return match ? Number(match[1]) : null;
}

// Node / undici / fetch network failures surface as `Error` with a `code` property.
const NETWORK_CODE_MAP: Record<string, { status: number; code: ApiErrorCode; retryable: boolean }> =
  {
    ECONNREFUSED: { status: 502, code: API_ERROR_CODES.UPSTREAM_UNAVAILABLE, retryable: true },
    ENOTFOUND: { status: 502, code: API_ERROR_CODES.UPSTREAM_UNAVAILABLE, retryable: false },
    ECONNRESET: { status: 502, code: API_ERROR_CODES.UPSTREAM_UNAVAILABLE, retryable: true },
    ETIMEDOUT: { status: 504, code: API_ERROR_CODES.UPSTREAM_TIMEOUT, retryable: true },
    UND_ERR_CONNECT_TIMEOUT: { status: 504, code: API_ERROR_CODES.UPSTREAM_TIMEOUT, retryable: true },
    UND_ERR_BODY_TIMEOUT: { status: 504, code: API_ERROR_CODES.UPSTREAM_TIMEOUT, retryable: true },
    UND_ERR_SOCKET: { status: 502, code: API_ERROR_CODES.UPSTREAM_UNAVAILABLE, retryable: true },
  };

function statusToCode(status: number): { code: ApiErrorCode; retryable: boolean } {
  if (status === 401 || status === 403) return { code: API_ERROR_CODES.UPSTREAM_AUTH, retryable: false };
  if (status === 402) return { code: API_ERROR_CODES.UPSTREAM_PAYMENT_REQUIRED, retryable: false };
  if (status === 404) return { code: API_ERROR_CODES.UPSTREAM_NOT_FOUND, retryable: false };
  if (status === 429) return { code: API_ERROR_CODES.UPSTREAM_RATE_LIMIT, retryable: true };
  if (status === 408 || status === 504) return { code: API_ERROR_CODES.UPSTREAM_TIMEOUT, retryable: true };
  if (status >= 500 && status < 600) return { code: API_ERROR_CODES.UPSTREAM_UNAVAILABLE, retryable: true };
  return { code: API_ERROR_CODES.UPSTREAM_ERROR, retryable: false };
}

function asString(x: unknown): string {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (x instanceof Error) return x.message;
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

// Heuristic: pull a Retry-After seconds value from any of the places providers stash it.
function extractRetryAfter(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as Record<string, unknown>;
  const fromHeader =
    (e.responseHeaders as Record<string, string> | undefined)?.['retry-after'] ??
    (e.headers as Record<string, string> | undefined)?.['retry-after'];
  if (fromHeader) {
    const n = Number(fromHeader);
    if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
    const asDate = Date.parse(fromHeader);
    if (Number.isFinite(asDate)) {
      return Math.max(0, Math.ceil((asDate - Date.now()) / 1000));
    }
  }
  const msg = asString(e.message);
  const m = msg.match(/retry[_ -]?after[":\s]+(\d+)/i);
  return m ? Number(m[1]) : undefined;
}

export function classifyUpstreamError(error: unknown): ClassifiedUpstreamError {
  // 1. Abort — the user hung up mid-stream. Don't punish retries with 5xx.
  if (error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message))) {
    return {
      status: 499,
      code: API_ERROR_CODES.CLIENT_CLOSED_REQUEST,
      message: 'Client closed the request before the upstream completed',
      retryable: false,
    };
  }

  // 2. Vercel AI SDK errors — richest source; has status + response body.
  if (isAICallError(error)) {
    const status = error.statusCode ?? 500;
    const { code, retryable } = statusToCode(status);
    const retryAfterSeconds = extractRetryAfter(error);
    return {
      status,
      code,
      message: error.message ?? 'Upstream provider error',
      upstreamStatus: status,
      upstreamDetails: error.responseBody ?? error.data,
      retryable: error.isRetryable ?? retryable,
      retryAfterSeconds,
    };
  }

  // 3. Node network errors — detect by `code` or by error message containing the code.
  if (error instanceof Error) {
    const nodeCode = (error as unknown as { code?: string }).code;
    const detected = nodeCode && NETWORK_CODE_MAP[nodeCode];
    if (detected) {
      return {
        status: detected.status,
        code: detected.code,
        message: error.message,
        retryable: detected.retryable,
      };
    }
    for (const key of Object.keys(NETWORK_CODE_MAP)) {
      if (error.message.includes(key)) {
        const d = NETWORK_CODE_MAP[key];
        return { status: d.status, code: d.code, message: error.message, retryable: d.retryable };
      }
    }
  }

  const msg = asString(error);

  // 4. MiniMax — 200 OK with a JSON payload indicating failure; our TTS wrapper rethrows it as an Error.
  if (/MiniMax/i.test(msg) || /base_resp/.test(msg)) {
    const minimaxCode = extractMinimaxStatusCode(msg);
    if (minimaxCode != null) {
      const mapped = MINIMAX_CODE_MAP[minimaxCode] ?? {
        status: 502,
        code: API_ERROR_CODES.UPSTREAM_ERROR,
      };
      return {
        status: mapped.status,
        code: mapped.code,
        message: msg,
        upstreamStatus: 200, // MiniMax returned a literal 200 OK with a failure body — keep that faithful.
        upstreamCode: minimaxCode,
        retryable: mapped.code === API_ERROR_CODES.UPSTREAM_RATE_LIMIT,
      };
    }
  }

  // 5. Text-pattern fallbacks — many SDKs throw plain Errors with the HTTP status baked into the message.
  //    "Incorrect API key provided" is OpenAI's 401 phrasing; we surface it as auth so it stops pretending to be 500.
  //    "API key required ..." is what our own provider adapters throw when preflight finds no credentials —
  //    semantically an auth condition, not a generic 500.
  if (
    /\bIncorrect API key\b/i.test(msg) ||
    /\bAPI key required\b/i.test(msg) ||
    /\bNo API key\b/i.test(msg) ||
    /\b401\b/.test(msg) ||
    /\bUnauthorized\b/i.test(msg)
  ) {
    return {
      status: 401,
      code: API_ERROR_CODES.UPSTREAM_AUTH,
      message: msg,
      upstreamStatus: 401,
      retryable: false,
    };
  }
  if (/\b429\b/.test(msg) || /rate[_\- ]?limit/i.test(msg)) {
    return {
      status: 429,
      code: API_ERROR_CODES.UPSTREAM_RATE_LIMIT,
      message: msg,
      upstreamStatus: 429,
      retryable: true,
      retryAfterSeconds: extractRetryAfter(error),
    };
  }
  if (/\b404\b/.test(msg) || /not[_\- ]?found/i.test(msg) || /model.*not.*exist/i.test(msg)) {
    return {
      status: 404,
      code: API_ERROR_CODES.UPSTREAM_NOT_FOUND,
      message: msg,
      upstreamStatus: 404,
      retryable: false,
    };
  }
  if (/timeout/i.test(msg)) {
    return {
      status: 504,
      code: API_ERROR_CODES.UPSTREAM_TIMEOUT,
      message: msg,
      upstreamStatus: 504,
      retryable: true,
    };
  }

  // 6. Unknown — fall through. 500 is correct here: we genuinely don't know what went wrong.
  return {
    status: 500,
    code: API_ERROR_CODES.INTERNAL_ERROR,
    message: msg || 'Unknown error',
    retryable: false,
  };
}

export interface ApiErrorFromUpstreamOptions {
  // When the classifier cannot attribute the error to an upstream call (genuinely-internal failure),
  // this is the code we emit instead of INTERNAL_ERROR. Lets per-route handlers stay contextual
  // (e.g. TTS uses GENERATION_FAILED; verify-model uses UPSTREAM_ERROR).
  defaultCode?: ApiErrorCode;
}

export function apiErrorFromUpstream(
  error: unknown,
  options: ApiErrorFromUpstreamOptions = {},
): NextResponse<ApiErrorBody> {
  const classified = classifyUpstreamError(error);
  const code =
    classified.code === API_ERROR_CODES.INTERNAL_ERROR && options.defaultCode
      ? options.defaultCode
      : classified.code;

  const headers: Record<string, string> = {};
  if (classified.retryAfterSeconds !== undefined) {
    headers['Retry-After'] = String(classified.retryAfterSeconds);
  }

  return apiError(code, {
    status: classified.status,
    error: classified.message,
    upstreamStatus: classified.upstreamStatus,
    upstreamCode: classified.upstreamCode,
    upstreamDetails: classified.upstreamDetails,
    retryable: classified.retryable,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
  });
}
