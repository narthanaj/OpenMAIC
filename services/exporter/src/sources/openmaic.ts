import { request } from 'undici';
import { ClassroomSchema, type Classroom } from '../validation/classroom.js';

// Typed errors so the worker can map to the right FailureReason metric label without
// parsing error messages. Each carries the classroom id we were trying to fetch.

export class ClassroomNotFoundError extends Error {
  readonly code = 'fetch_404';
  constructor(public readonly classroomId: string) {
    super(`classroom ${classroomId} not found on OpenMAIC`);
  }
}

export class UpstreamError extends Error {
  readonly code = 'fetch_upstream';
  constructor(
    public readonly classroomId: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`OpenMAIC upstream error ${status} for classroom ${classroomId}: ${body.slice(0, 200)}`);
  }
}

export class FetchValidationError extends Error {
  readonly code = 'validation';
  constructor(
    public readonly classroomId: string,
    public readonly issues: unknown,
  ) {
    super(`OpenMAIC response for classroom ${classroomId} failed schema validation`);
  }
}

export class FetchTimeoutError extends Error {
  readonly code = 'timeout';
  constructor(public readonly classroomId: string) {
    super(`OpenMAIC fetch for classroom ${classroomId} timed out`);
  }
}

export interface OpenMaicClient {
  fetchClassroomById(id: string): Promise<Classroom>;
}

// OpenMAIC returns its classroom payload under `{ success: true, data: { classroom: {...} } }`
// (see openmaic app/api/classroom/route.ts apiSuccess wrapper). We tolerate both the wrapped
// and a bare `{ classroom: {...} }` shape below; the inner classroom is then parsed via
// the full ClassroomSchema so any shape drift surfaces as a typed FetchValidationError.

export function createOpenMaicClient(baseUrl: string, timeoutMs = 10_000): OpenMaicClient {
  // Trim trailing slash once so concat below is predictable.
  const base = baseUrl.replace(/\/+$/, '');

  async function fetchClassroomById(id: string): Promise<Classroom> {
    const url = `${base}/api/classroom?id=${encodeURIComponent(id)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res;
    try {
      res = await request(url, {
        method: 'GET',
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
    } catch (err: unknown) {
      clearTimeout(timer);
      if ((err as Error)?.name === 'AbortError') throw new FetchTimeoutError(id);
      // Network-level failures (DNS, connection refused) are upstream errors with
      // status 0 by convention; the metric label handles it under fetch_upstream.
      throw new UpstreamError(id, 0, (err as Error).message ?? 'network error');
    }
    clearTimeout(timer);

    const body = await res.body.text();

    if (res.statusCode === 404) throw new ClassroomNotFoundError(id);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new UpstreamError(id, res.statusCode, body);
    }

    // Parse envelope, then extract + validate the classroom shape.
    let envelope: unknown;
    try {
      envelope = JSON.parse(body);
    } catch {
      throw new UpstreamError(id, res.statusCode, 'non-JSON response');
    }

    // OpenMAIC's apiSuccess wraps payloads as { success:true, data: {classroom: {...}} }.
    // Tolerate both the wrapped and the flat shapes.
    const raw = (() => {
      const e = envelope as Record<string, unknown>;
      if (e && typeof e === 'object') {
        const data = e.data as Record<string, unknown> | undefined;
        if (data && typeof data === 'object' && 'classroom' in data) {
          return data.classroom;
        }
        if ('classroom' in e) return e.classroom;
      }
      return envelope;
    })();

    const parsed = ClassroomSchema.safeParse(raw);
    if (!parsed.success) {
      throw new FetchValidationError(id, parsed.error.issues);
    }
    return parsed.data;
  }

  return { fetchClassroomById };
}
