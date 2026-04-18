import type { TTSProviderId } from './types';

// Minimal duck-typed shape of the settings-store entries we need for the fallback chain.
// The settings store's `TTSProviderConfig` (in lib/store/settings.ts) has more fields; we avoid
// importing it here to keep this module usable outside the store's dependency graph.
interface ConfiguredTTSEntry {
  apiKey?: string;
  isServerConfigured?: boolean;
}

export interface RequestTTSParams {
  text: string;
  audioId: string;
  ttsProviderId: TTSProviderId;
  ttsVoice: string;
  ttsModelId?: string;
  ttsSpeed?: number;
  // Per-provider credentials sent by the client. The server will re-resolve from env/yaml when omitted.
  ttsApiKey?: string;
  ttsBaseUrl?: string;
  // Server-configured TTS providers the user has set up. The server tries each in order if the
  // primary provider fails with an auth/5xx/rate-limit. See lib/audio/tts-fallback.ts.
  fallbackProviderIds?: TTSProviderId[];
  signal?: AbortSignal;
}

export type RequestTTSResult =
  | {
      source: 'server';
      base64: string;
      format: string;
      providerUsed: TTSProviderId;
      // Set when a server-side fallback succeeded after the primary failed. The caller can surface
      // this to the user ("Voice generation used OpenAI because MiniMax was unreachable").
      fallbackUsed?: TTSProviderId;
    }
  | {
      source: 'browser-native';
      // Returned on terminal server failure. Bytes are unavailable, so IndexedDB persistence is
      // impossible. The caller decides whether to play via `playViaBrowserNative(text, voice)`
      // (appropriate at playback time) or stay silent (appropriate during background scene
      // generation — playing would leak narration while the user has paused the classroom).
      reason: string;
    };

// Build `fallbackProviderIds` from the settings store. Rules:
// - Skip the primary provider.
// - Skip browser-native-tts (client-only; the server can't synthesize it).
// - Skip providers that have no credentials server-side AND no client-side key — they would 401.
// Callers pass the Zustand store snapshot so this module stays framework-agnostic and SSR-safe.
export function deriveTTSFallbackChain(
  primary: TTSProviderId,
  ttsProvidersConfig: Record<string, ConfiguredTTSEntry | undefined>,
): TTSProviderId[] {
  const out: TTSProviderId[] = [];
  for (const [pid, cfg] of Object.entries(ttsProvidersConfig)) {
    if (!cfg) continue;
    if (pid === primary) continue;
    if (pid === 'browser-native-tts') continue;
    if (!cfg.isServerConfigured && !cfg.apiKey) continue;
    out.push(pid as TTSProviderId);
  }
  return out;
}

// Best-effort client-side speech using the Web Speech API. Always available on modern browsers,
// no credentials, but voice selection is whatever the OS exposes — quality varies.
export function playViaBrowserNative(text: string, voiceHint?: string): void {
  if (typeof window === 'undefined') return;
  const synth = window.speechSynthesis;
  if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return;
  try {
    synth.cancel(); // avoid overlapping with a prior utterance still in the queue
    const utter = new SpeechSynthesisUtterance(text);
    if (voiceHint) {
      const voice = synth.getVoices().find((v) => v.name.toLowerCase().includes(voiceHint.toLowerCase()));
      if (voice) utter.voice = voice;
    }
    synth.speak(utter);
  } catch {
    // Swallow — this is already the fallback; there's no further recourse if it throws.
  }
}

// Shown once per tab lifetime so the user knows their primary TTS provider failed but audio still plays.
let degradationToastShownAt = 0;
const DEGRADATION_TOAST_WINDOW_MS = 60_000;

export function shouldShowDegradationToast(): boolean {
  const now = Date.now();
  if (now - degradationToastShownAt < DEGRADATION_TOAST_WINDOW_MS) return false;
  degradationToastShownAt = now;
  return true;
}

// Pure "fetch bytes or report why we couldn't" entry point. Never plays audio itself — the server
// path returns a descriptor for the caller to persist + play later, and the browser-native path
// returns a marker so the caller can decide whether to trigger Web Speech (via playViaBrowserNative)
// or stay silent. Background scene generation must stay silent, because the user may have paused
// the classroom; narrating the fallback out loud there was the original root cause of the
// "voice interrupts slideshow while I'm waiting for generation" bug.
export async function requestTTSAudio(params: RequestTTSParams): Promise<RequestTTSResult> {
  const { text, signal, ...rest } = params;
  try {
    const response = await fetch('/api/generate/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, ...rest }),
      signal,
    });

    const data = await response
      .json()
      .catch(() => ({ success: false, error: response.statusText || 'Invalid TTS response' }));

    if (response.ok && data?.success && data.base64 && data.format) {
      return {
        source: 'server',
        base64: data.base64,
        format: data.format,
        providerUsed: (data.fallbackUsed ?? params.ttsProviderId) as TTSProviderId,
        fallbackUsed: data.fallbackUsed as TTSProviderId | undefined,
      };
    }

    // Server failed. Propagate abort if caller requested cancel; otherwise report the reason so
    // the caller can decide playback policy. DO NOT play audio here — see the comment on the
    // `browser-native` variant of RequestTTSResult.
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const reason =
      data?.error || data?.details || `TTS request failed: HTTP ${response.status}`;
    return { source: 'browser-native', reason };
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') throw err;
    // Network-level failure (DNS, offline). Same contract — caller decides playback.
    return {
      source: 'browser-native',
      reason: err instanceof Error ? err.message : 'TTS request failed',
    };
  }
}
