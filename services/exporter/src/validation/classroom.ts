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
    // ClassroomManifest (.maic.zip / .classroom.json) strips the IndexedDB
    // audioId and replaces it with a path-shaped pointer: "audio/<id>.mp3".
    // The renderer uses this to emit `<audio src="../audio/<id>.mp3">` only
    // when the corresponding blob was actually bundled — so broken refs in
    // the manifest are rendered as silent speech, not as 404s in the player.
    audioRef: z.string().optional(),
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

// SceneSchema accepts legacy DB-shaped scenes (with ids) AND ClassroomManifest
// scenes (where ids are stripped because the export format is id-independent).
// Missing id → the exporter mints one from order at render time.
export const SceneSchema = z
  .object({
    id: z.string().min(1).optional(),
    order: z.number().int().nonnegative(),
    title: z.string().optional(),
    actions: z.array(ActionSchema).default([]),
    // .maic.zip additions — all optional passthrough; exporter cherry-picks.
    type: z.string().optional(),
    content: z.unknown().optional(),
    whiteboards: z.array(z.unknown()).optional(),
    multiAgent: z.unknown().optional(),
  })
  .passthrough();

export const StageSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1),
    description: z.string().optional(),
    language: z.string().optional(),
    style: z.string().optional(),
  })
  .passthrough();

// Tolerates both:
//   - Legacy classroom JSON: { id, stage: {id, name, ...}, scenes: [{id, order, ...}] }
//   - .maic.zip manifest: { stage: {name, ...}, agents, scenes: [{type, order, content, ...}], mediaIndex }
//     (id fields stripped by OpenMAIC's export; caller mints them during rendering.)
export const ClassroomSchema = z
  .object({
    id: z.string().min(1).optional(),
    stage: StageSchema,
    scenes: z.array(SceneSchema).min(1, 'classroom must have at least one scene'),
    // .maic.zip additions — all optional passthrough.
    agents: z.array(z.unknown()).optional(),
    mediaIndex: z.record(z.string(), z.unknown()).optional(),
    formatVersion: z.number().optional(),
    exportedAt: z.string().optional(),
    appVersion: z.string().optional(),
  })
  .passthrough();

export type Classroom = z.infer<typeof ClassroomSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type Stage = z.infer<typeof StageSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type SpeechAction = z.infer<typeof SpeechActionSchema>;
