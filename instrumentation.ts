// Next.js picks up this file automatically on server boot when
// `experimental.instrumentationHook` is enabled (on by default in Next 16).
// It registers OpenTelemetry so spans emitted via `lib/observability/tracing.ts`
// are exported to whatever OTLP endpoint the operator configures.
//
// Why this lives at repo root and not under lib/: Next's convention. Moving it breaks the hook.
// Why it's one line of real logic: everything else is in @vercel/otel's `registerOTel`, which is
// the blessed path for Next 16 server-side tracing.

import { registerOTel } from '@vercel/otel';

export function register() {
  // OTEL_EXPORTER_OTLP_ENDPOINT selects a collector (Grafana Tempo, Jaeger, Honeycomb, ...).
  // When unset, spans are no-op'd — production safe: zero-cost when unconfigured.
  registerOTel({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'openmaic',
  });
}
