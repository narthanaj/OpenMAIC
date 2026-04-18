import { NextResponse } from 'next/server';

export const API_ERROR_CODES = {
  MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
  MISSING_API_KEY: 'MISSING_API_KEY',
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_URL: 'INVALID_URL',
  REDIRECT_NOT_ALLOWED: 'REDIRECT_NOT_ALLOWED',
  CONTENT_SENSITIVE: 'CONTENT_SENSITIVE',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  // Status-preserving upstream codes (B3). Surface the vendor's status instead of collapsing to 500,
  // so debuggers and client retry logic can act on it rather than guessing from a message string.
  UPSTREAM_AUTH: 'UPSTREAM_AUTH',
  UPSTREAM_PAYMENT_REQUIRED: 'UPSTREAM_PAYMENT_REQUIRED',
  UPSTREAM_RATE_LIMIT: 'UPSTREAM_RATE_LIMIT',
  UPSTREAM_NOT_FOUND: 'UPSTREAM_NOT_FOUND',
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
  UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT',
  CLIENT_CLOSED_REQUEST: 'CLIENT_CLOSED_REQUEST',
  GENERATION_FAILED: 'GENERATION_FAILED',
  TRANSCRIPTION_FAILED: 'TRANSCRIPTION_FAILED',
  PARSE_FAILED: 'PARSE_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];

export interface ApiErrorBody {
  success: false;
  errorCode: ApiErrorCode;
  error: string;
  details?: string;
  // Forwarded from the upstream provider so the client keeps fidelity instead of parsing message strings.
  upstreamStatus?: number;
  upstreamCode?: string | number;
  upstreamDetails?: unknown;
  retryable?: boolean;
}

export interface ApiErrorInit {
  status: number;
  error: string;
  details?: string;
  upstreamStatus?: number;
  upstreamCode?: string | number;
  upstreamDetails?: unknown;
  retryable?: boolean;
  headers?: Record<string, string>;
}

// Dual call shape: existing `apiError('CODE', 500, 'msg', 'details')` callers keep working.
// New call sites pass a structured init (apiErrorFromUpstream uses this).
export function apiError(code: ApiErrorCode, init: ApiErrorInit): NextResponse<ApiErrorBody>;
export function apiError(
  code: ApiErrorCode,
  status: number,
  error: string,
  details?: string,
): NextResponse<ApiErrorBody>;
export function apiError(
  code: ApiErrorCode,
  statusOrInit: number | ApiErrorInit,
  error?: string,
  details?: string,
): NextResponse<ApiErrorBody> {
  const init: ApiErrorInit =
    typeof statusOrInit === 'number'
      ? { status: statusOrInit, error: error ?? '', details }
      : statusOrInit;

  const body: ApiErrorBody = {
    success: false as const,
    errorCode: code,
    error: init.error,
  };
  if (init.details) body.details = init.details;
  if (init.upstreamStatus !== undefined) body.upstreamStatus = init.upstreamStatus;
  if (init.upstreamCode !== undefined) body.upstreamCode = init.upstreamCode;
  if (init.upstreamDetails !== undefined) body.upstreamDetails = init.upstreamDetails;
  if (init.retryable !== undefined) body.retryable = init.retryable;

  return NextResponse.json(body, { status: init.status, headers: init.headers });
}

export function apiSuccess<T extends Record<string, unknown>>(data: T, status = 200): NextResponse {
  return NextResponse.json({ success: true, ...data }, { status });
}
