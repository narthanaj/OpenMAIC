import { z } from 'zod';

// Zod schema for an OpenMAIC classroom. The schema is the source of truth — TS types
// below are derived via z.infer to guarantee runtime validation and compile-time types
// stay in lockstep (no drift).
//
// .passthrough() on every object is deliberate: the exporter only cherry-picks a few
// fields, and OpenMAIC evolves its classroom shape independently. We must NOT reject
// classrooms that carry extra fields we don't consume — only reject when the fields
// WE need are missing or malformed.

export const SpeechActionSchema = z
  .object({
    type: z.literal('speech'),
    id: z.string().min(1),
    text: z.string(),
  })
  .passthrough();

// Generic action: we don't render most action types in v1 (slides-only). Accept any
// type/id shape; the SCORM exporter cherry-picks what it needs.
export const ActionSchema = z
  .object({
    type: z.string().min(1),
    id: z.string().min(1),
  })
  .passthrough();

export const SceneSchema = z
  .object({
    id: z.string().min(1),
    order: z.number().int().nonnegative(),
    title: z.string().optional(),
    actions: z.array(ActionSchema).default([]),
  })
  .passthrough();

export const StageSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    language: z.string().optional(),
  })
  .passthrough();

export const ClassroomSchema = z
  .object({
    id: z.string().min(1),
    stage: StageSchema,
    scenes: z.array(SceneSchema).min(1, 'classroom must have at least one scene'),
  })
  .passthrough();

export type Classroom = z.infer<typeof ClassroomSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type Stage = z.infer<typeof StageSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type SpeechAction = z.infer<typeof SpeechActionSchema>;
