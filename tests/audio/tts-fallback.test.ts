import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { TTSFallbackAttempt } from '@/lib/audio/tts-fallback';

vi.mock('@/lib/audio/tts-providers', () => ({
  // Each test injects its own implementation via mockImplementation below.
  generateTTS: vi.fn(),
}));

import { generateTTS } from '@/lib/audio/tts-providers';
import { generateTTSWithFallback } from '@/lib/audio/tts-fallback';

const mocked = vi.mocked(generateTTS);

function link(id: string, overrides: Partial<TTSFallbackAttempt> = {}): TTSFallbackAttempt {
  return {
    providerId: id as TTSFallbackAttempt['providerId'],
    voice: 'v',
    speed: 1,
    apiKey: 'k',
    ...overrides,
  };
}

// Emulate the shape AI SDK errors have (duck-typed by classifyUpstreamError).
function apiError(status: number, message: string) {
  const e = new Error(message) as Error & Record<string, unknown>;
  e.name = 'AI_APICallError';
  e.statusCode = status;
  return e;
}

describe('generateTTSWithFallback', () => {
  beforeEach(() => {
    mocked.mockReset();
  });

  it('returns the primary result on first success', async () => {
    mocked.mockResolvedValueOnce({ audio: new Uint8Array([1]), format: 'mp3' });
    const outcome = await generateTTSWithFallback([link('minimax-tts'), link('openai-tts')], 'hi');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.usedProviderId).toBe('minimax-tts');
    expect(outcome.attempts).toHaveLength(1);
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it('falls back on 401 to the next provider', async () => {
    mocked
      .mockRejectedValueOnce(apiError(401, 'Incorrect API key'))
      .mockResolvedValueOnce({ audio: new Uint8Array([2]), format: 'mp3' });
    const outcome = await generateTTSWithFallback(
      [link('minimax-tts'), link('openai-tts')],
      'hi',
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.usedProviderId).toBe('openai-tts');
    expect(outcome.attempts).toHaveLength(2);
    expect(outcome.attempts[0]).toMatchObject({ ok: false, status: 401, errorCode: 'UPSTREAM_AUTH' });
    expect(outcome.attempts[1]).toMatchObject({ ok: true, providerId: 'openai-tts' });
  });

  it('falls back on 429 (rate-limit)', async () => {
    mocked
      .mockRejectedValueOnce(apiError(429, 'rate limited'))
      .mockResolvedValueOnce({ audio: new Uint8Array([3]), format: 'mp3' });
    const outcome = await generateTTSWithFallback([link('minimax-tts'), link('glm-tts')], 'hi');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.usedProviderId).toBe('glm-tts');
  });

  it('does NOT fall back on 400 (deterministic failure — would waste credits)', async () => {
    mocked.mockRejectedValueOnce(apiError(400, 'text too long'));
    const outcome = await generateTTSWithFallback([link('minimax-tts'), link('openai-tts')], 'hi');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(mocked).toHaveBeenCalledTimes(1); // stopped at primary
    expect(outcome.attempts).toHaveLength(1);
  });

  it('returns failure when every link errors', async () => {
    mocked
      .mockRejectedValueOnce(apiError(401, 'bad key 1'))
      .mockRejectedValueOnce(apiError(401, 'bad key 2'));
    const outcome = await generateTTSWithFallback([link('minimax-tts'), link('openai-tts')], 'hi');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.attempts).toHaveLength(2);
    expect(outcome.attempts.every((a) => !a.ok)).toBe(true);
  });

  it('empty chain returns failure without calling provider', async () => {
    const outcome = await generateTTSWithFallback([], 'hi');
    expect(outcome.ok).toBe(false);
    expect(mocked).not.toHaveBeenCalled();
  });
});
