import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { scormV1_2Exporter } from '@/exporters/scorm1_2/index.js';
import type { Classroom } from '@/validation/classroom.js';

// Spot-checks the SCORM 1.2 package shape: the ZIP must contain the manifest,
// entry HTML, runtime JS, and per-scene HTML. Each scene HTML should reference
// the runtime. The manifest must declare the right schema namespaces so LMSs
// can parse it.

const classroom: Classroom = {
  id: 'cls_test',
  stage: {
    id: 'stg',
    name: 'Intro to Testing',
    description: 'A short test classroom',
    language: 'en',
  },
  scenes: [
    { id: 'sc1', order: 0, title: 'Welcome', actions: [{ type: 'speech', id: 'sp1', text: 'Hello class.' } as any] },
    { id: 'sc2', order: 1, title: 'Goodbye', actions: [{ type: 'speech', id: 'sp2', text: 'Thanks for joining.' } as any] },
  ],
};

function collectToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  // JSZip's generateNodeStream() returns a stream that's event-based but does NOT
  // expose Symbol.asyncIterator, so `for await` throws. Use the classic .on('data')
  // / .on('end') pattern which every Node stream supports.
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

describe('SCORM 1.2 exporter', () => {
  it('produces a ZIP with manifest + entry + runtime + per-scene HTML', async () => {
    const stream = await scormV1_2Exporter.export(classroom);
    const bytes = await collectToBuffer(stream);
    const zip = await JSZip.loadAsync(bytes);

    // Manifest present and recognizable.
    const manifest = await zip.file('imsmanifest.xml')?.async('string');
    expect(manifest).toBeTruthy();
    expect(manifest).toMatch(/<manifest[^>]*version="1.2"/);
    expect(manifest).toMatch(/<schema>ADL SCORM<\/schema>/);
    expect(manifest).toMatch(/<schemaversion>1.2<\/schemaversion>/);
    // One <item> per scene.
    const itemMatches = (manifest ?? '').match(/<item /g) ?? [];
    expect(itemMatches.length).toBe(classroom.scenes.length);

    // Entry HTML redirects into the first scene.
    const entry = await zip.file('index.html')?.async('string');
    expect(entry).toBeTruthy();
    expect(entry).toMatch(/scenes\/001\.html/);

    // Runtime script.
    const runtime = await zip.file('runtime.js')?.async('string');
    expect(runtime).toBeTruthy();
    expect(runtime).toMatch(/LMSInitialize/);
    expect(runtime).toMatch(/LMSFinish/);

    // Scene files exist with narration text baked in.
    const s1 = await zip.file('scenes/001.html')?.async('string');
    const s2 = await zip.file('scenes/002.html')?.async('string');
    expect(s1).toMatch(/Hello class\./);
    expect(s2).toMatch(/Thanks for joining\./);
    // Each scene references the runtime.
    expect(s1).toMatch(/runtime\.js/);
    expect(s2).toMatch(/runtime\.js/);
    // Navigation: first scene has a disabled Previous link, second has a working one.
    expect(s1).toMatch(/aria-disabled="true"[^<]*&larr;/);
    expect(s2).toMatch(/href="001\.html"/);
  });

  it('handles single-scene classrooms (both prev and next disabled)', async () => {
    const single: Classroom = {
      id: 'cls_one',
      stage: { id: 'stg', name: 'Solo' },
      scenes: [{ id: 'sc1', order: 0, actions: [] }],
    };
    const stream = await scormV1_2Exporter.export(single);
    const bytes = await collectToBuffer(stream);
    const zip = await JSZip.loadAsync(bytes);
    const s1 = (await zip.file('scenes/001.html')?.async('string')) ?? '';
    // Both nav slots should be aria-disabled on a single-scene package.
    // Match only within <a ...> opening tags — the shared CSS also contains
    // `aria-disabled="true"]` as a selector and would otherwise inflate the count.
    const disabledCount = (s1.match(/<a aria-disabled="true"/g) ?? []).length;
    expect(disabledCount).toBe(2);
  });

  it('sorts scenes by order before emitting files', async () => {
    const unsorted: Classroom = {
      id: 'cls_unsorted',
      stage: { id: 'stg', name: 'Shuffled' },
      scenes: [
        { id: 'b', order: 1, title: 'Second', actions: [] },
        { id: 'a', order: 0, title: 'First', actions: [] },
      ],
    };
    const stream = await scormV1_2Exporter.export(unsorted);
    const zip = await JSZip.loadAsync(await collectToBuffer(stream));
    const s1 = (await zip.file('scenes/001.html')?.async('string')) ?? '';
    const s2 = (await zip.file('scenes/002.html')?.async('string')) ?? '';
    expect(s1).toMatch(/<title>First<\/title>/);
    expect(s2).toMatch(/<title>Second<\/title>/);
  });
});
