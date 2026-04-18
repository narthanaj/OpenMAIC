import { NextRequest } from 'next/server';
import { generateText } from 'ai';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { applyRateLimit } from '@/lib/server/rate-limit';
import { apiErrorFromUpstream } from '@/lib/server/upstream-error';
import { resolveModel } from '@/lib/server/resolve-model';
const log = createLogger('Verify Model');

export async function POST(req: NextRequest) {
  const rateLimited = applyRateLimit('verify', req);
  if (rateLimited) return rateLimited;

  let model: string | undefined;
  try {
    const body = await req.json();
    const { apiKey, baseUrl, providerType } = body;
    model = body.model;

    if (!model) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Model name is required');
    }

    // Parse model string and resolve server-side fallback
    let languageModel;
    try {
      const result = await resolveModel({
        modelString: model,
        apiKey: apiKey || '',
        baseUrl: baseUrl || undefined,
        providerType,
      });
      languageModel = result.model;
    } catch (error) {
      return apiError(
        'INVALID_REQUEST',
        401,
        error instanceof Error ? error.message : String(error),
      );
    }

    // Send a minimal test message
    const { text } = await generateText({
      model: languageModel,
      prompt: 'Say "OK" if you can hear me.',
    });

    return apiSuccess({
      message: 'Connection successful',
      response: text,
    });
  } catch (error) {
    log.error(`Model verification failed [model="${model ?? 'unknown'}"]:`, error);
    // Forward the vendor's real HTTP status (401/402/404/429/5xx) and payload to the client.
    // Replaces the previous string-sniffing branches that all returned 500.
    return apiErrorFromUpstream(error, { defaultCode: 'UPSTREAM_ERROR' });
  }
}
