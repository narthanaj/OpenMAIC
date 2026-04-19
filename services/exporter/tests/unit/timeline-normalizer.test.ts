import { describe, expect, it } from 'vitest';
import {
  normalizeSceneTimeline,
  TIMELINE_DURATIONS,
  type TimelineEntry,
} from '@/exporters/shared/timeline.js';
import type { Scene } from '@/validation/classroom.js';

// Unit tests for the α.3 timeline normalizer. These are pure TS — no server,
// no ZIP, no DOM — so they're fast and let us exercise every action type
// individually. The normalizer is the most behaviorally rich part of α.3;
// render-scene.ts just projects its output into HTML.
//
// Duration pointers are validated against the constants exported from the
// module itself, so a constant rename here trips the tests.

function scene(actions: unknown[], overrides: Partial<Scene> = {}): Scene {
  return {
    order: 0,
    title: 'T',
    actions: actions as Scene['actions'],
    ...overrides,
  } as Scene;
}

describe('normalizeSceneTimeline', () => {
  it('drops scenes with no actions', () => {
    expect(normalizeSceneTimeline(scene([]), undefined)).toEqual([]);
  });

  it('drops unknown action types silently', () => {
    const entries = normalizeSceneTimeline(
      scene([{ type: 'not_a_real_type', id: 'x' }]),
      undefined,
    );
    expect(entries).toEqual([]);
  });

  it('drops actions with missing or non-string type', () => {
    const entries = normalizeSceneTimeline(
      scene([
        { type: '', id: 'a' },
        { id: 'b' } as unknown,
        { type: 42, id: 'c' } as unknown,
      ]),
      undefined,
    );
    expect(entries).toEqual([]);
  });

  it('drops empty-text speech actions', () => {
    const entries = normalizeSceneTimeline(
      scene([
        { type: 'speech', id: 's1', text: '   ' },
        { type: 'speech', id: 's2', text: '' },
      ]),
      undefined,
    );
    expect(entries).toEqual([]);
  });

  it('maps a speech action with bundled audio to audio + captionElementId ids', () => {
    const audio = new Set(['audio/tts_sp1.mp3']);
    const [entry] = normalizeSceneTimeline(
      scene([
        {
          type: 'speech',
          id: 'sp1',
          text: 'Hello class.',
          audioRef: 'audio/tts_sp1.mp3',
        },
      ]),
      audio,
    );
    expect(entry).toMatchObject<Partial<TimelineEntry>>({
      type: 'speech',
      text: 'Hello class.',
      audio: '../audio/tts_sp1.mp3',
      audioElementId: 'timeline-audio-0',
      captionElementId: 'timeline-caption-0',
    });
    expect(entry.duration).toBeGreaterThanOrEqual(TIMELINE_DURATIONS.speechFallbackMinMs);
  });

  it('maps a speech action without bundled audio to caption-only entry', () => {
    const [entry] = normalizeSceneTimeline(
      scene([{ type: 'speech', id: 'sp1', text: 'Hello.', audioRef: 'audio/missing.mp3' }]),
      new Set(), // nothing bundled
    );
    expect(entry.type).toBe('speech');
    expect(entry.audio).toBeUndefined();
    expect(entry.audioElementId).toBeUndefined();
    expect(entry.captionElementId).toBe('timeline-caption-0');
  });

  it('maps a speech action with no audioRef to caption-only entry', () => {
    const [entry] = normalizeSceneTimeline(
      scene([{ type: 'speech', id: 'sp1', text: 'Offline narration.' }]),
      undefined,
    );
    expect(entry.audio).toBeUndefined();
    expect(entry.audioElementId).toBeUndefined();
  });

  it('clamps speech fallback duration to [min, max]', () => {
    const [shortEntry] = normalizeSceneTimeline(
      scene([{ type: 'speech', id: 'sp1', text: 'Hi.' }]),
      undefined,
    );
    expect(shortEntry.duration).toBe(TIMELINE_DURATIONS.speechFallbackMinMs);

    const hugeText = new Array(200).fill('word').join(' ');
    const [longEntry] = normalizeSceneTimeline(
      scene([{ type: 'speech', id: 'sp2', text: hugeText }]),
      undefined,
    );
    expect(longEntry.duration).toBe(TIMELINE_DURATIONS.speechFallbackMaxMs);
  });

  it('maps spotlight and laser to fire-and-forget with auto-clear duration', () => {
    const entries = normalizeSceneTimeline(
      scene([
        { type: 'spotlight', id: 'spot', elementId: 'el1', dimOpacity: 0.4 },
        { type: 'laser', id: 'las', elementId: 'el2', color: '#ff0000' },
      ]),
      undefined,
    );
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      expect(e.fireAndForget).toBe(true);
      expect(e.duration).toBe(TIMELINE_DURATIONS.effectAutoClearMs);
    }
    expect(entries[0]!.elementId).toBe('el1');
    expect(entries[1]!.elementId).toBe('el2');
  });

  it('maps every whiteboard synchronous action to its engine.ts duration', () => {
    const entries = normalizeSceneTimeline(
      scene([
        { type: 'wb_open', id: 'o' },
        { type: 'wb_draw_text', id: 'dt', content: 'hi', x: 0, y: 0 },
        { type: 'wb_draw_shape', id: 'ds', shape: 'rectangle', x: 0, y: 0, width: 10, height: 10 },
        { type: 'wb_draw_chart', id: 'dc', chartType: 'bar', x: 0, y: 0, width: 10, height: 10, data: {} },
        { type: 'wb_draw_latex', id: 'dl', latex: 'a=b', x: 0, y: 0 },
        { type: 'wb_draw_table', id: 'dtab', data: [[]], x: 0, y: 0, width: 10, height: 10 },
        { type: 'wb_draw_line', id: 'dln', startX: 0, startY: 0, endX: 10, endY: 10 },
        { type: 'wb_edit_code', id: 'ec', elementId: 'code1', operation: 'delete_lines' },
        { type: 'wb_delete', id: 'del', elementId: 'x' },
        { type: 'wb_clear', id: 'clr' },
        { type: 'wb_close', id: 'cls' },
      ]),
      undefined,
    );
    const by = new Map(entries.map((e) => [e.type, e]));
    expect(by.get('wb_open')!.duration).toBe(TIMELINE_DURATIONS.wbOpenMs);
    expect(by.get('wb_draw_text')!.duration).toBe(TIMELINE_DURATIONS.wbDrawMs);
    expect(by.get('wb_draw_shape')!.duration).toBe(TIMELINE_DURATIONS.wbDrawMs);
    expect(by.get('wb_draw_chart')!.duration).toBe(TIMELINE_DURATIONS.wbDrawMs);
    expect(by.get('wb_draw_latex')!.duration).toBe(TIMELINE_DURATIONS.wbDrawMs);
    expect(by.get('wb_draw_table')!.duration).toBe(TIMELINE_DURATIONS.wbDrawMs);
    expect(by.get('wb_draw_line')!.duration).toBe(TIMELINE_DURATIONS.wbDrawMs);
    expect(by.get('wb_edit_code')!.duration).toBe(TIMELINE_DURATIONS.wbEditCodeMs);
    expect(by.get('wb_delete')!.duration).toBe(TIMELINE_DURATIONS.wbDeleteMs);
    expect(by.get('wb_clear')!.duration).toBe(TIMELINE_DURATIONS.wbClearMaxMs);
    expect(by.get('wb_close')!.duration).toBe(TIMELINE_DURATIONS.wbCloseMs);
    for (const e of entries) expect(e.fireAndForget).toBeUndefined();
  });

  it('wb_draw_code scales by line count and caps at wbDrawCodeCapMs', () => {
    const shortCode = 'console.log(1);';
    const [short] = normalizeSceneTimeline(
      scene([{ type: 'wb_draw_code', id: 'c1', language: 'js', code: shortCode, x: 0, y: 0 }]),
      undefined,
    );
    expect(short.duration).toBe(
      TIMELINE_DURATIONS.wbDrawCodeBaseMs + 1 * TIMELINE_DURATIONS.wbDrawCodePerLineMs,
    );

    const longCode = new Array(80).fill('x = 1;').join('\n');
    const [long] = normalizeSceneTimeline(
      scene([{ type: 'wb_draw_code', id: 'c2', language: 'js', code: longCode, x: 0, y: 0 }]),
      undefined,
    );
    expect(long.duration).toBe(TIMELINE_DURATIONS.wbDrawCodeCapMs);
  });

  it('maps play_video and discussion to their fallback constants', () => {
    const entries = normalizeSceneTimeline(
      scene([
        { type: 'play_video', id: 'v1', elementId: 'el' },
        { type: 'discussion', id: 'd1', topic: 'something' },
      ]),
      undefined,
    );
    expect(entries[0]!.duration).toBe(TIMELINE_DURATIONS.playVideoFallbackMs);
    expect(entries[1]!.duration).toBe(TIMELINE_DURATIONS.discussionPreCardMs);
  });

  it('preserves entry order from the source actions array', () => {
    const entries = normalizeSceneTimeline(
      scene([
        { type: 'speech', id: 'a', text: 'first' },
        { type: 'wb_draw_text', id: 'b', content: 'x', x: 0, y: 0 },
        { type: 'speech', id: 'c', text: 'second' },
      ]),
      new Set(),
    );
    expect(entries.map((e) => e.type)).toEqual(['speech', 'wb_draw_text', 'speech']);
    // Caption ids index into the output (not the source) list — second speech
    // gets timeline-caption-2 because the wb_draw_text occupies index 1.
    expect(entries[0]!.captionElementId).toBe('timeline-caption-0');
    expect(entries[2]!.captionElementId).toBe('timeline-caption-2');
  });
});
