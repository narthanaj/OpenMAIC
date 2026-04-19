import { z } from 'zod';

// The `POST /export/:format` body is pull-mode only:
//   { classroomId: "...", webhookUrl?: "..." }
//
// The push variant ({ classroom: {...inline JSON...} }) was removed when the UI
// moved to local-first browser-side zipping — see the architecture-pivot plan
// and the local-first feedback memory. `.strict()` rejects unknown fields, which
// gives callers who are still sending the old `classroom` body a clear 400 with
// the unrecognized-key message instead of silently accepting and failing later.

export const ExportRequestSchema = z
  .object({
    classroomId: z.string().min(1),
    webhookUrl: z.string().url().optional(),
  })
  .strict();

export type ExportRequest = z.infer<typeof ExportRequestSchema>;

// Route-param validation for :format — keeps unknown formats out of the worker path.
export const FormatParamSchema = z.object({
  format: z.string().min(1),
});

// Job id param — narrowly scoped to the generator we use for new jobs.
// The exporter uses crypto.randomUUID() (see jobs/types.ts → newJob).
export const JobIdParamSchema = z.object({
  id: z.string().uuid(),
});
