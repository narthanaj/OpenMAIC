import type { TTSModelConfig, TTSProviderId } from './types';
import { generateTTS, type TTSGenerationResult } from './tts-providers';
import { classifyUpstreamError } from '@/lib/server/upstream-error';
import { withSpan, addSpanEvent } from '@/lib/observability/tracing';

// One link in the chain. The caller assembles these with already-resolved credentials per provider,
// so the fallback executor doesn't need to know about env vars, yaml configs, or SSRF guards.
export interface TTSFallbackAttempt {
  providerId: TTSProviderId;
  modelId?: string;
  voice: string;
  speed: number;
  apiKey: string;
  baseUrl?: string;
}

export interface TTSFallbackStep {
  providerId: TTSProviderId;
  ok: boolean;
  status?: number;
  errorCode?: string;
  message?: string;
  retryable?: boolean;
}

export interface TTSFallbackSuccess {
  ok: true;
  result: TTSGenerationResult;
  usedProviderId: TTSProviderId;
  attempts: TTSFallbackStep[];
}

export interface TTSFallbackFailure {
  ok: false;
  lastError: unknown;
  attempts: TTSFallbackStep[];
}

// We keep retrying down the chain only on errors that *might* succeed elsewhere — auth failures,
// rate limits, network issues. If MiniMax returns a 400 "text too long" it will almost always fail
// on OpenAI TTS too; retrying wastes credits and hides the real problem.
function isWorthFallingBack(status: number, code: string): boolean {
  if (status === 401 || status === 402 || status === 403) return true; // credentials issue on this provider
  if (status === 429) return true; // this provider rate-limited
  if (status >= 500 && status < 600) return true; // this provider down
  if (status === 404 && code === 'UPSTREAM_NOT_FOUND') return true; // e.g. voice id not on this provider
  return false;
}

// Run the chain in order, return the first success. The config passed in already has per-provider
// credentials resolved, because credential resolution happens only on the server (env / yml) and
// the route handler is the only layer that has both the client request and the server state.
export async function generateTTSWithFallback(
  chain: TTSFallbackAttempt[],
  text: string,
): Promise<TTSFallbackSuccess | TTSFallbackFailure> {
  const attempts: TTSFallbackStep[] = [];
  let lastError: unknown = new Error('Empty fallback chain');

  for (let i = 0; i < chain.length; i++) {
    const link = chain[i];
    const config: TTSModelConfig = {
      providerId: link.providerId,
      modelId: link.modelId,
      voice: link.voice,
      speed: link.speed,
      apiKey: link.apiKey,
      baseUrl: link.baseUrl,
    };
    try {
      // One span per *attempt*, so a fallback chain becomes N sibling spans in the trace view.
      const result = await withSpan(
        'tts.generate',
        {
          'tts.provider': link.providerId,
          'tts.voice': link.voice,
          'tts.model': link.modelId,
          'tts.speed': link.speed,
          'tts.attempt': i,
          'tts.is_fallback': i > 0,
          'tts.text_length': text.length,
        },
        () => generateTTS(config, text),
      );
      attempts.push({ providerId: link.providerId, ok: true });
      if (i > 0) {
        addSpanEvent('tts.fallback_succeeded', { 'tts.fallback_provider': link.providerId });
      }
      return { ok: true, result, usedProviderId: link.providerId, attempts };
    } catch (err) {
      lastError = err;
      const classified = classifyUpstreamError(err);
      attempts.push({
        providerId: link.providerId,
        ok: false,
        status: classified.status,
        errorCode: classified.code,
        message: classified.message,
        retryable: classified.retryable,
      });
      if (!isWorthFallingBack(classified.status, classified.code)) {
        // Deterministic failure (malformed text, content policy) — don't burn credits on fallbacks.
        break;
      }
    }
  }

  addSpanEvent('tts.chain_exhausted', { 'tts.attempts': attempts.length });
  return { ok: false, lastError, attempts };
}
