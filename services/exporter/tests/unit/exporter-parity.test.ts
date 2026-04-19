import { describe, expect, it } from 'vitest';
import { buildZipFiles as backendScormFiles } from '@/exporters/scorm1_2/index.js';
import { buildZipFiles as backendHtmlFiles } from '@/exporters/html/index.js';
// Browser-side exporters live in the UI service so the parity test must reach
// across repos (relative path). These files are plain ES modules — no TypeScript,
// no node:* imports, no DOM — so they load fine under Node at test time.
// @ts-ignore — vanilla JS imports, no .d.ts.
import { buildZipFiles as browserScormFiles } from '../../../ui/public/exporters/scorm1_2.js';
// @ts-ignore
import { buildZipFiles as browserHtmlFiles } from '../../../ui/public/exporters/html.js';
import type { Classroom } from '@/validation/classroom.js';

// Parity test — guards against drift between the backend TypeScript exporters and
// the browser vanilla-JS ports. See the feedback memory: "deliberate duplication
// with parity tests." We compare the FILE-LIST output of each exporter's
// buildZipFiles helper rather than the assembled ZIP bytes, because:
//   1. ZIP envelopes embed mtime → two archives of the same content built seconds
//      apart differ at the byte level. Byte-equality assertions fail spuriously.
//   2. The ZIP envelope isn't what we care about — the LOGICAL CONTENTS
//      (imsmanifest.xml, per-scene HTML, runtime.js, etc.) are. Comparing the
//      file list directly isolates the thing we actually want to check.
//
// If someone touches only one side of the duplication, this test fails.

const FIXTURE: Classroom = {
  id: 'cls_parity_fixture',
  stage: {
    id: 'stg_parity',
    name: 'Parity Test Classroom',
    description: 'A fixture to cross-check backend and browser exporters produce matching content.',
    language: 'en',
  },
  scenes: [
    {
      id: 'sc1',
      order: 0,
      title: 'First Slide',
      actions: [{ type: 'speech', id: 'sp1', text: 'Hello from scene one.' } as any],
    },
    {
      // α.3 — multi-action scene exercises the timeline normalizer on every
      // action category (speech, fire-and-forget, whiteboard sync). Any drift
      // in duration constants or entry fields between backend + UI trips here.
      id: 'sc2',
      order: 1,
      title: 'Second Slide',
      actions: [
        { type: 'speech', id: 'sp2', text: 'Hello from scene two.' } as any,
        { type: 'spotlight', id: 'spot1', elementId: 'target1', dimOpacity: 0.4 } as any,
        { type: 'wb_draw_text', id: 'dt1', content: 'Board note', x: 10, y: 10 } as any,
        { type: 'speech', id: 'sp3', text: 'Back to narration.' } as any,
        { type: 'other', id: 'o1' } as any, // unknown type — both exporters drop it
      ],
    },
    {
      id: 'sc3',
      order: 2,
      // no title — exporter should fall back to "Slide N"
      actions: [],
    },
  ],
};

function toMap(files: Array<{ path: string; content: string | Uint8Array }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of files) {
    out[f.path] = typeof f.content === 'string' ? f.content : Buffer.from(f.content).toString('utf8');
  }
  return out;
}

describe('exporter parity (backend TS vs browser JS)', () => {
  it('scorm1.2: same file paths, same file contents', () => {
    const a = toMap(backendScormFiles(FIXTURE, 'en'));
    const b = toMap(browserScormFiles(FIXTURE, 'en'));
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    for (const path of Object.keys(a)) {
      // Per-file string equality. If this fires, open both files side-by-side to
      // find the drift — usually whitespace, attribute order, or a template tweak
      // that only landed on one side.
      expect(b[path], `content differs at ${path}`).toBe(a[path]);
    }
  });

  it('html: same file paths, same file contents', () => {
    const a = toMap(backendHtmlFiles(FIXTURE, 'en'));
    const b = toMap(browserHtmlFiles(FIXTURE, 'en'));
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    for (const path of Object.keys(a)) {
      expect(b[path], `content differs at ${path}`).toBe(a[path]);
    }
  });
});
