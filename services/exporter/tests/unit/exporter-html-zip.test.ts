import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { htmlExporter } from '@/exporters/html/index.js';
import type { Classroom } from '@/validation/classroom.js';

// The HTML format must produce a self-contained ZIP that opens without any
// LMS/runtime. Shape:
//   index.html           — TOC (landing page, not a redirect)
//   scenes/001.html      — first slide, nav links to 002 + back to TOC
//   scenes/NNN.html      — last slide, nav disabled forward, back to TOC
//
// Unlike SCORM 1.2, there must be NO runtime.js, NO imsmanifest.xml, and NO
// window.__SCORM_SLIDE__ injection.

const classroom: Classroom = {
  id: 'cls_html_test',
  stage: {
    id: 'stg',
    name: 'HTML Export Test',
    description: 'A self-contained static HTML classroom.',
    language: 'en',
  },
  scenes: [
    { id: 'a', order: 0, title: 'First', actions: [{ type: 'speech', id: 'sp1', text: 'Hi.' } as any] },
    { id: 'b', order: 1, title: 'Second', actions: [{ type: 'speech', id: 'sp2', text: 'Bye.' } as any] },
  ],
};

function collectToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

describe('HTML exporter', () => {
  it('produces a ZIP with TOC + per-scene HTML, no SCORM artifacts', async () => {
    const stream = await htmlExporter.export(classroom);
    const bytes = await collectToBuffer(stream);
    const zip = await JSZip.loadAsync(bytes);

    // SCORM-only files must be absent.
    expect(zip.file('imsmanifest.xml')).toBeNull();
    expect(zip.file('runtime.js')).toBeNull();

    // TOC is present and lists both scenes.
    const toc = await zip.file('index.html')?.async('string');
    expect(toc).toBeTruthy();
    expect(toc).toMatch(/<title>HTML Export Test<\/title>/);
    expect(toc).toMatch(/scenes\/001\.html/);
    expect(toc).toMatch(/scenes\/002\.html/);
    // TOC must be a real landing page, not a redirect.
    expect(toc).not.toMatch(/http-equiv="refresh"/);
    // Description copied through.
    expect(toc).toMatch(/A self-contained static HTML classroom\./);

    // Scene pages have nav + narration, no SCORM runtime hooks.
    const s1 = await zip.file('scenes/001.html')?.async('string');
    const s2 = await zip.file('scenes/002.html')?.async('string');
    expect(s1).toMatch(/Hi\./);
    expect(s2).toMatch(/Bye\./);
    expect(s1).not.toMatch(/__SCORM_SLIDE__/);
    expect(s1).not.toMatch(/runtime\.js/);
    expect(s1).not.toMatch(/LMSInitialize/);
    // TOC back-link is present.
    expect(s1).toMatch(/href="\.\.\/index\.html"/);
    expect(s2).toMatch(/href="\.\.\/index\.html"/);
    // Prev on first scene disabled; next on last scene disabled.
    const first = s1 ?? '';
    const last = s2 ?? '';
    expect((first.match(/<a aria-disabled="true"/g) ?? []).length).toBe(1);
    expect((last.match(/<a aria-disabled="true"/g) ?? []).length).toBe(1);
    // Inter-scene nav uses relative filenames (same dir), not absolute paths.
    expect(s2).toMatch(/href="001\.html"/);
    expect(s1).toMatch(/href="002\.html"/);
  });

  it('works for single-scene classrooms (both nav slots disabled, TOC still present)', async () => {
    const single: Classroom = {
      id: 'cls_one',
      stage: { id: 'stg', name: 'Only One' },
      scenes: [{ id: 'x', order: 0, title: 'The Only Slide', actions: [] }],
    };
    const stream = await htmlExporter.export(single);
    const zip = await JSZip.loadAsync(await collectToBuffer(stream));
    expect(await zip.file('index.html')?.async('string')).toBeTruthy();
    const s1 = (await zip.file('scenes/001.html')?.async('string')) ?? '';
    expect((s1.match(/<a aria-disabled="true"/g) ?? []).length).toBe(2);
  });

  it('handles missing optional fields (no description, no language)', async () => {
    const bare: Classroom = {
      id: 'cls_bare',
      stage: { id: 'stg', name: 'Minimal' },
      scenes: [{ id: 'a', order: 0, actions: [] }],
    };
    const stream = await htmlExporter.export(bare);
    const zip = await JSZip.loadAsync(await collectToBuffer(stream));
    const toc = await zip.file('index.html')?.async('string');
    expect(toc).toMatch(/<title>Minimal<\/title>/);
    // Defaults to language="en" when classroom didn't specify one.
    expect(toc).toMatch(/<html lang="en">/);
  });
});
