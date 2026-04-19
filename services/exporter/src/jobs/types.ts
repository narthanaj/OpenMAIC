import { randomUUID } from 'node:crypto';

export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface Job {
  id: string;
  format: string;
  status: JobStatus;
  // Always set in pull-only mode (current design). Nullable for forward compatibility
  // if a new flow later creates jobs without a classroomId.
  classroomId: string | null;
  // Caller-provided callback URL. On terminal state we POST progress there.
  webhookUrl: string | null;
  // Populated on failure. Human-readable, not a stack trace.
  error: string | null;
  // Opaque storage key for the produced ZIP; null until status='done'.
  resultKey: string | null;
  createdAt: number; // epoch ms
  updatedAt: number;
}

// Centralized factory so we keep job ids collision-proof and pull in the default
// createdAt / updatedAt + null fields without leaking boilerplate into callers.
export function newJob(format: string, classroomId: string | null, webhookUrl: string | null): Job {
  const now = Date.now();
  return {
    id: randomUUID(),
    format,
    status: 'pending',
    classroomId,
    webhookUrl,
    error: null,
    resultKey: null,
    createdAt: now,
    updatedAt: now,
  };
}

// Narrow classes of failure for the metrics label `reason` — keeps cardinality bounded
// so Prometheus doesn't drown in per-job error strings.
export type FailureReason =
  | 'fetch_404'       // OpenMAIC doesn't have this classroom
  | 'fetch_upstream'  // OpenMAIC 5xx or network
  | 'validation'      // fetched payload failed ClassroomSchema
  | 'render'          // exporter threw while producing HTML / XML
  | 'zip'             // JSZip error
  | 'storage'         // ExportStorage.put failed
  | 'timeout'         // worker exceeded per-job budget (not wired in v1)
  | 'shutdown'        // abandoned because service was terminating
  | 'other';
