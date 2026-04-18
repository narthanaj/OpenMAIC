import { trace, SpanStatusCode, type Span, type SpanOptions } from '@opentelemetry/api';
import { classifyUpstreamError } from '@/lib/server/upstream-error';

// Single tracer for the whole app. Tracer name ends up as `otel.library.name` on every span.
// Using "openmaic" (matching the default service name) keeps Grafana/Tempo queries simple.
const tracer = trace.getTracer('openmaic');

// Allowed span attribute value types per OTel spec. We narrow here so callers get type-checking
// instead of the SDK's looser `AttributeValue` (which silently drops unsupported values).
export type SpanAttrValue = string | number | boolean;
export type SpanAttrs = Record<string, SpanAttrValue | undefined>;

function setAttrs(span: Span, attrs?: SpanAttrs): void {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    span.setAttribute(k, v);
  }
}

// Run `fn` inside a span. On throw, classify the error via B3's classifier and attach the real
// HTTP status + vendor code to the span before rethrowing — so a trace alone tells you whether
// a failure was auth, rate-limit, or network, without pulling the log line.
export async function withSpan<T>(
  name: string,
  attrs: SpanAttrs | undefined,
  fn: (span: Span) => Promise<T> | T,
  opts: SpanOptions = {},
): Promise<T> {
  return tracer.startActiveSpan(name, opts, async (span) => {
    setAttrs(span, attrs);
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      const classified = classifyUpstreamError(err);
      span.setAttribute('error.http_status', classified.status);
      span.setAttribute('error.code', classified.code);
      if (classified.upstreamStatus !== undefined) {
        span.setAttribute('error.upstream_status', classified.upstreamStatus);
      }
      if (classified.upstreamCode !== undefined) {
        span.setAttribute('error.upstream_code', String(classified.upstreamCode));
      }
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

// One-shot event on the current span — for annotating things that happen *inside* an existing
// span (e.g. "TTS fallback fired") without starting a new one.
export function addSpanEvent(name: string, attrs?: SpanAttrs): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  const filtered: Record<string, SpanAttrValue> = {};
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined) continue;
      filtered[k] = v;
    }
  }
  span.addEvent(name, filtered);
}
