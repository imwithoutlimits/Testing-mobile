import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Utterance } from '../../../packages/core/src/model.ts';
import { buildChapters, ffmetadata, runExport, type ChunkMeta } from './export.ts';
import { packageAudio } from './tts/package.ts';
import { pcmToMp3 } from './tts/ffmpeg.ts';

const u = (i: number, sectionId: string): Utterance => ({ id: `u${i}`, blockId: `b${i}`, sectionId, kind: 'paragraph', text: 't', spoken: 't', pauseAfterMs: 0 });
const utts = [u(0, 's1'), u(1, 's1'), u(2, 's2'), u(3, 's2'), u(4, 's3')];
const metas: ChunkMeta[] = [
  { start: 0, end: 2, durationMs: 60_000, items: [{ index: 0, startMs: 0 }, { index: 1, startMs: 20_000 }, { index: 2, startMs: 40_000 }] },
  { start: 3, end: 4, durationMs: 30_000, items: [{ index: 3, startMs: 0 }, { index: 4, startMs: 25_000 }] },
];
const titles = { s1: 'Intro', s2: 'Middle', s3: 'End' };

test('chapters follow real timing across parts; tiny sections merge; first starts at zero', () => {
  const c = buildChapters(utts, titles, metas, 'Doc');
  assert.deepEqual(c.map((x) => [x.title, x.startMs, x.endMs]), [['Intro', 0, 40_000], ['Middle', 40_000, 90_000]]); // "End" is 5 s long, so it joins "Middle"
  const all = buildChapters(utts, titles, metas, 'Doc', 1000);
  assert.deepEqual(all.map((x) => x.startMs), [0, 40_000, 85_000]);
  assert.deepEqual(buildChapters([], {}, [], 'Only'), [{ startMs: 0, endMs: 0, title: 'Only' }]);
});

test('ffmetadata escapes special characters', () => {
  const m = ffmetadata([{ startMs: 0, endMs: 1500, title: 'A=B; C#1' }], { title: 'Book', artist: 'Ana' });
  assert.ok(m.startsWith(';FFMETADATA1\ntitle=Book\nartist=Ana'));
  assert.ok(m.includes('title=A\\=B\\; C\\#1') && m.includes('START=0') && m.includes('END=1500') && m.includes('TIMEBASE=1/1000'));
});

test('runExport reports progress, packages once, and marks ready', async () => {
  const states: string[] = [];
  let packaged = 0, result: Record<string, unknown> | undefined;
  await runExport({
    chunkCount: 2, utterances: utts, titles, docTitle: 'Doc', format: 'mp3',
    generate: async (ci) => ({ meta: metas[ci], mp3: Buffer.from('x') }),
    setJob: async (p) => { if (p.state) states.push(p.state); if (p.result) result = p.result; },
    packageAudio: async () => { packaged++; return Buffer.from('file'); },
    upload: async () => 'u/d/exports/1.mp3',
  });
  assert.deepEqual(states, ['generating', 'generating', 'packaging', 'ready']);
  assert.equal(packaged, 1);
  assert.deepEqual([result?.path, result?.durationMs, result?.bytes], ['u/d/exports/1.mp3', 90_000, 4]);
});

test('runExport marks the job failed with a readable message and never packages', async () => {
  const seen: Array<{ state?: string; error?: string }> = [];
  let packaged = false;
  await runExport({
    chunkCount: 3, utterances: utts, titles, docTitle: 'Doc', format: 'm4b',
    generate: async (ci) => { if (ci === 1) throw new Error('You have used this month\'s allowance.'); return { meta: metas[0], mp3: Buffer.from('x') }; },
    setJob: async (p) => { seen.push(p); },
    packageAudio: async () => { packaged = true; return Buffer.from(''); },
    upload: async () => '',
  });
  assert.equal(packaged, false);
  assert.deepEqual(seen[seen.length - 1], { state: 'failed', error: "You have used this month's allowance." });
});

const hasFfmpeg = (() => { try { execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('real ffmpeg: parts join into one file with chapter markers (mp3 and m4b)', { skip: !hasFfmpeg }, async () => {
  const tone = (sec: number, hz: number) => Int16Array.from({ length: 24000 * sec }, (_, i) => Math.round(8000 * Math.sin((2 * Math.PI * hz * i) / 24000)));
  const parts = [await pcmToMp3(tone(2, 440), 24000), await pcmToMp3(tone(2, 660), 24000)];
  const chapters = [{ startMs: 0, endMs: 2000, title: 'One' }, { startMs: 2000, endMs: 4000, title: 'Two' }];
  for (const format of ['mp3', 'm4b'] as const) {
    const file = await packageAudio(parts, ffmetadata(chapters, { title: 'Test book', artist: 'Ana' }), format);
    const dir = mkdtempSync(join(tmpdir(), 'probe-'));
    try {
      const p = join(dir, `out.${format}`);
      writeFileSync(p, file);
      const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_chapters', '-show_format', '-print_format', 'json', p]).toString());
      assert.equal(info.chapters.length, 2, `${format} chapters`);
      assert.deepEqual(info.chapters.map((c: { tags: { title: string } }) => c.tags.title), ['One', 'Two']);
      assert.ok(Math.abs(Number(info.format.duration) - 4) < 0.5, `${format} duration ${info.format.duration}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
