import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { requestTTSAudio } from '@/lib/audio/tts-client';
import type { TTSProviderId } from '@/lib/audio/types';

// Regression test for the "voice narration interrupts the slideshow while generation is in
// progress" bug. Root cause: requestTTSAudio used to call window.speechSynthesis.speak() as a
// side effect whenever the server TTS call failed. That made the helper unusable during
// background scene generation, because the user may have paused the classroom and any live
// playback leaked out regardless. The fix turns requestTTSAudio into a pure descriptor-returning
// function — it MUST NOT touch window.speechSynthesis on any code path.

describe('requestTTSAudio — must never play audio itself', () => {
  const speakSpy = vi.fn();
  const cancelSpy = vi.fn();
  const getVoicesSpy = vi.fn(() => []);

  beforeEach(() => {
    speakSpy.mockReset();
    cancelSpy.mockReset();
    getVoicesSpy.mockReset();
    // Stub a minimal Web Speech API so we'd observe any accidental call. Node has no `window`
    // globally — any touch of speechSynthesis by the code under test would have been silently
    // no-op'd otherwise, hiding regressions.
    vi.stubGlobal('window', {
      speechSynthesis: { speak: speakSpy, cancel: cancelSpy, getVoices: getVoicesSpy },
    });
    vi.stubGlobal(
      'SpeechSynthesisUtterance',
      class {
        voice: unknown = null;
        constructor(public text: string) {}
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const baseParams = {
    text: 'slide narration',
    audioId: 'tts_1',
    ttsProviderId: 'openai-tts' as TTSProviderId,
    ttsVoice: 'alloy',
  };

  it('returns server descriptor on 2xx success (no audio side effect)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ success: true, base64: 'aGVsbG8=', format: 'mp3' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ) as typeof fetch;

    const result = await requestTTSAudio(baseParams);

    expect(result.source).toBe('server');
    if (result.source !== 'server') return;
    expect(result.base64).toBe('aGVsbG8=');
    expect(result.format).toBe('mp3');
    expect(result.providerUsed).toBe('openai-tts');
    expect(speakSpy).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it('returns browser-native marker on non-2xx WITHOUT calling speechSynthesis.speak (the bug fix)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ success: false, error: 'Incorrect API key' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      ),
    ) as typeof fetch;

    const result = await requestTTSAudio(baseParams);

    expect(result.source).toBe('browser-native');
    if (result.source !== 'browser-native') return;
    expect(result.reason).toContain('Incorrect API key');
    // The core regression assertion: no audio may play as a side effect.
    expect(speakSpy).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it('returns browser-native marker on network failure WITHOUT calling speechSynthesis.speak', async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('offline')) as typeof fetch;

    const result = await requestTTSAudio(baseParams);

    expect(result.source).toBe('browser-native');
    if (result.source !== 'browser-native') return;
    expect(result.reason).toBe('offline');
    expect(speakSpy).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it('propagates AbortError without playing audio', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    globalThis.fetch = vi.fn().mockRejectedValueOnce(abortErr) as typeof fetch;

    const ac = new AbortController();
    ac.abort();

    await expect(
      requestTTSAudio({ ...baseParams, signal: ac.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(speakSpy).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it('surfaces "malformed response" reason when the server returns invalid JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response('<!doctype html><html><body>500</body></html>', {
        status: 502,
        statusText: 'Bad Gateway',
      }),
    ) as typeof fetch;

    const result = await requestTTSAudio(baseParams);

    expect(result.source).toBe('browser-native');
    if (result.source !== 'browser-native') return;
    expect(result.reason).toBeTruthy();
    expect(speakSpy).not.toHaveBeenCalled();
  });
});
