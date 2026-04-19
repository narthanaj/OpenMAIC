import { describe, expect, it } from 'vitest';
import { ClassroomSchema } from '@/validation/classroom.js';

// The classroom schema is the single source of truth for what the exporter is
// willing to process. Tests guard both shapes: (a) accept known-good classrooms,
// including those with extra fields OpenMAIC adds that we don't care about, and
// (b) reject malformed input with paths that point at the bad field.

const MINIMAL_VALID = {
  id: 'cls_1',
  stage: { id: 's1', name: 'Intro to X' },
  scenes: [
    { id: 'sc1', order: 0, actions: [] },
  ],
};

describe('ClassroomSchema', () => {
  it('accepts the minimal valid shape', () => {
    const result = ClassroomSchema.safeParse(MINIMAL_VALID);
    expect(result.success).toBe(true);
  });

  it('accepts a classroom with extra OpenMAIC fields (passthrough)', () => {
    const extended = {
      ...MINIMAL_VALID,
      createdAt: Date.now(),
      stage: { ...MINIMAL_VALID.stage, theme: 'dark', openmaicInternalKey: 'xyz' },
      scenes: [
        {
          ...MINIMAL_VALID.scenes[0],
          unknownActionProperty: true,
          actions: [{ type: 'whiteboard-draw', id: 'wd1', futureField: 42 }],
        },
      ],
    };
    const result = ClassroomSchema.safeParse(extended);
    expect(result.success).toBe(true);
  });

  it('rejects missing stage.name with a pointed error path', () => {
    const bad = { ...MINIMAL_VALID, stage: { id: 's1' } };
    const result = ClassroomSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.error.issues.map((i) => i.path.join('.'));
    expect(paths.some((p) => p === 'stage.name')).toBe(true);
  });

  it('rejects a classroom with zero scenes', () => {
    const bad = { ...MINIMAL_VALID, scenes: [] };
    const result = ClassroomSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path.join('.') === 'scenes')).toBe(true);
  });

  it('accepts scene without id (manifest-shape tolerance)', () => {
    // α.1 relaxed the schema to accept OpenMAIC's .maic.zip manifest, which
    // strips id fields. Callers (the manifest adapter) synthesize ids at
    // conversion time. A scene with just {order, actions} should now pass.
    const valid = {
      ...MINIMAL_VALID,
      scenes: [{ order: 0, actions: [] }],
    };
    const result = ClassroomSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('rejects scene with missing order (still required)', () => {
    const bad = {
      ...MINIMAL_VALID,
      scenes: [{ id: 'sc1', actions: [] }],
    };
    const result = ClassroomSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path.join('.').startsWith('scenes.0.order'))).toBe(true);
  });

  it('accepts .maic.zip manifest-shape extras (agents, mediaIndex, formatVersion)', () => {
    const manifestish = {
      stage: { name: 'Intro to X' },   // no id — manifest shape
      scenes: [
        { order: 0, title: 'Hello', actions: [], type: 'slide', content: { type: 'slide', canvas: {} } },
      ],
      agents: [{ name: 'Teacher', role: 'teacher' }],
      mediaIndex: { 'audio/sp1.mp3': { type: 'audio', format: 'mp3' } },
      formatVersion: 1,
      exportedAt: '2026-04-19T00:00:00Z',
      appVersion: '0.1.1',
    };
    const result = ClassroomSchema.safeParse(manifestish);
    expect(result.success).toBe(true);
  });

  it('defaults scenes[].actions to [] when omitted', () => {
    const minus = {
      ...MINIMAL_VALID,
      scenes: [{ id: 'sc1', order: 0 }],
    };
    const result = ClassroomSchema.safeParse(minus);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.scenes[0].actions).toEqual([]);
  });
});
