/**
 * Single TTS Generation API
 *
 * Generates TTS audio for a single text string and returns base64-encoded audio.
 * Called by the client in parallel for each speech action after a scene is generated.
 *
 * POST /api/generate/tts
 */

import { NextRequest } from 'next/server';
import { resolveTTSApiKey, resolveTTSBaseUrl } from '@/lib/server/provider-config';
import type { TTSProviderId } from '@/lib/audio/types';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { apiErrorFromUpstream } from '@/lib/server/upstream-error';
import { applyRateLimit } from '@/lib/server/rate-limit';
import { generateTTSWithFallback, type TTSFallbackAttempt } from '@/lib/audio/tts-fallback';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';

const log = createLogger('TTS API');

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const rateLimited = applyRateLimit('tts', req);
  if (rateLimited) return rateLimited;

  let ttsProviderId: string | undefined;
  let ttsVoice: string | undefined;
  let audioId: string | undefined;
  try {
    const body = await req.json();
    const {
      text,
      ttsModelId,
      ttsSpeed,
      ttsApiKey,
      ttsBaseUrl,
      fallbackProviderIds,
    } = body as {
      text: string;
      audioId: string;
      ttsProviderId: TTSProviderId;
      ttsModelId?: string;
      ttsVoice: string;
      ttsSpeed?: number;
      ttsApiKey?: string;
      ttsBaseUrl?: string;
      // Optional ordered list of server-side providers to try if the primary fails with a
      // retryable/auth/5xx status. The client only sends provider *ids* — the server resolves each
      // key/base-url from env or yaml, so browser-side secrets never leak between providers.
      fallbackProviderIds?: TTSProviderId[];
    };
    ttsProviderId = body.ttsProviderId;
    ttsVoice = body.ttsVoice;
    audioId = body.audioId;

    if (!text || !audioId || !ttsProviderId || !ttsVoice) {
      return apiError(
        'MISSING_REQUIRED_FIELD',
        400,
        'Missing required fields: text, audioId, ttsProviderId, ttsVoice',
      );
    }

    if (ttsProviderId === 'browser-native-tts') {
      return apiError('INVALID_REQUEST', 400, 'browser-native-tts must be handled client-side');
    }

    const clientBaseUrl = ttsBaseUrl || undefined;
    if (clientBaseUrl && process.env.NODE_ENV === 'production') {
      const ssrfError = await validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    // Primary link uses whatever the client supplied for baseUrl/apiKey (overriding server resolution
    // when present). Fallback links always re-resolve from server state — we do not replay the
    // client's primary key onto fallback providers because keys aren't cross-provider.
    const primaryApiKey = clientBaseUrl
      ? ttsApiKey || ''
      : resolveTTSApiKey(ttsProviderId, ttsApiKey || undefined);
    const primaryBaseUrl = clientBaseUrl
      ? clientBaseUrl
      : resolveTTSBaseUrl(ttsProviderId, ttsBaseUrl || undefined);

    const chain: TTSFallbackAttempt[] = [
      {
        providerId: ttsProviderId as TTSProviderId,
        modelId: ttsModelId,
        voice: ttsVoice,
        speed: ttsSpeed ?? 1.0,
        apiKey: primaryApiKey,
        baseUrl: primaryBaseUrl,
      },
    ];

    // Filter out: the primary, duplicates, browser-native (client-only), and any provider we have
    // no server-resolvable key for. Last check prevents calling OpenAI TTS with "" as the key.
    const seen = new Set<string>([ttsProviderId]);
    for (const fid of fallbackProviderIds ?? []) {
      if (!fid || seen.has(fid) || fid === 'browser-native-tts') continue;
      seen.add(fid);
      const fallbackKey = resolveTTSApiKey(fid, undefined);
      if (!fallbackKey) continue;
      chain.push({
        providerId: fid,
        voice: ttsVoice, // voice may not exist on the fallback provider; TTS provider impls already guard this
        speed: ttsSpeed ?? 1.0,
        apiKey: fallbackKey,
        baseUrl: resolveTTSBaseUrl(fid, undefined),
      });
    }

    log.info(
      `Generating TTS: provider=${ttsProviderId}, model=${ttsModelId || 'default'}, voice=${ttsVoice}, audioId=${audioId}, textLen=${text.length}, chainLen=${chain.length}`,
    );

    const outcome = await generateTTSWithFallback(chain, text);

    if (!outcome.ok) {
      log.error(
        `TTS generation failed [provider=${ttsProviderId}, voice=${ttsVoice}, audioId=${audioId}, attempts=${JSON.stringify(outcome.attempts)}]:`,
        outcome.lastError,
      );
      return apiErrorFromUpstream(outcome.lastError, { defaultCode: 'GENERATION_FAILED' });
    }

    const { audio, format } = outcome.result;
    const base64 = Buffer.from(audio).toString('base64');
    const fallbackUsed =
      outcome.usedProviderId !== ttsProviderId ? outcome.usedProviderId : undefined;
    if (fallbackUsed) {
      log.warn(
        `TTS primary=${ttsProviderId} failed; fell back to ${fallbackUsed} (audioId=${audioId})`,
      );
    }

    return apiSuccess({
      audioId,
      base64,
      format,
      // Present only when the client's chosen provider didn't serve the audio, so the UI can surface
      // a one-time notice without polluting every success response.
      ...(fallbackUsed ? { fallbackUsed, attempts: outcome.attempts } : {}),
    });
  } catch (error) {
    // Reached only if the request parsing itself blew up (bad JSON, etc.). Provider errors are
    // handled above via generateTTSWithFallback + apiErrorFromUpstream.
    log.error(
      `TTS generation failed [provider=${ttsProviderId ?? 'unknown'}, voice=${ttsVoice ?? 'unknown'}, audioId=${audioId ?? 'unknown'}]:`,
      error,
    );
    return apiErrorFromUpstream(error, { defaultCode: 'GENERATION_FAILED' });
  }
}
