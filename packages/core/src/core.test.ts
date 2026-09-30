import test from 'node:test';
import assert from 'node:assert/strict';
import { guessHeading, parseStructure } from './structure.ts';
import { analyze, cleanPages, stripCitations, DEFAULT_CLEANUP } from './cleanup.ts';
import { splitSentences, wrapLong } from './sentences.ts';
import { MODE_PRESETS, applyPronunciations, buildUtterances } from './narration.ts';
import { searchDocument } from './search.ts';
import { audioCacheKey, chunkIndexFor, planChunks } from './chunks.ts';

test('headings: real headings detected, sentences are not', () => {
  assert.equal(guessHeading('Chapter 3: The Return')?.level, 1);
  assert.equal(guessHeading('2.1 Data collection')?.level, 3);
  assert.equal(guessHeading('# Title')?.level, 1);
  assert.equal(guessHeading('Part of the reason is that we ran out of time.'), null);
  assert.equal(guessHeading('Section I think this is fine, really, honestly.'), null);
});

test('parseStructure: markdown headings, lists, quotes, tables, sections', () => {
  const md = [
    '# My Book', 'Intro paragraph here.', '## Part One', '- first item', '- second item',
    '> A wise quote', '| a | b |\n|---|---|\n| 1 | 2 |', 'Closing words.',
  ].join('\n\n');
  const doc = parseStructure(md, { sourceType: 'md' });
  assert.equal(doc.title, 'My Book');
  assert.deepEqual(doc.blocks.map((b) => b.type), ['heading', 'paragraph', 'heading', 'list_item', 'list_item', 'quote', 'table', 'paragraph']);
  assert.equal(doc.sections.length, 2);
  assert.equal(doc.sections[0].title, 'My Book');
  assert.equal(doc.blocks.find((b) => b.type === 'table')?.rows?.length, 2);
});

function fakePdf(): string[] {
  const pages: string[] = [];
  for (let i = 1; i <= 5; i++) {
    pages.push([
      'Journal of Useful Things',
      `${['Rivers','Meadows','Forests','Valleys','Harbors'][i - 1]} were crossed by the quick brown fox as it kept running through the`,
      'meadow until it reaches a long-',
      'standing fence near the river.',
      i === 3 ? '1 See the appendix for details of the experiment.' : `${['Winter','Spring','Summer','Autumn','Monsoon'][i - 1]} arrived and the animals gathered near the water.`,
      String(i),
    ].join('\n'));
  }
  return pages;
}

test('analyze: page numbers, repeated headers, hyphenation, footnotes', () => {
  const r = analyze(fakePdf());
  assert.equal(r.pageNumbers, 5);
  assert.equal(r.repeatedHeaders, 5);
  assert.equal(r.hyphenatedWords, 5);
  assert.equal(r.footnotes, 1);
});

test('cleanPages: removes artifacts and fixes hyphenation/wraps', () => {
  const text = cleanPages(fakePdf(), DEFAULT_CLEANUP);
  assert.ok(!text.includes('Journal of Useful Things'));
  assert.ok(text.includes('longstanding fence'));
  assert.ok(!/^\d$/m.test(text));
});

test('cleanPages: single page keeps bare numbers, drops explicit page markers', () => {
  const t = cleanPages(['We counted\n42\nsheep.\n\nPage 7 of 9\n\nDone.'], DEFAULT_CLEANUP);
  assert.ok(t.includes('42'));
  assert.ok(!t.includes('Page 7'));
});

test('references removal and citation stripping', () => {
  const body = Array.from({ length: 12 }, (_, i) => `Body line ${i} with a claim [${i + 1}] and (Smith et al., 2020).`).join('\n\n');
  const doc = `${body}\n\nReferences\n\n[1] Smith, J. 2020. A paper.\n\n[2] Jones, K. 2019. Another.`;
  const r = analyze([doc]);
  assert.equal(r.references, 2);
  const cleaned = cleanPages([doc], { ...DEFAULT_CLEANUP, references: true, citations: true });
  assert.ok(!cleaned.includes('References'));
  assert.ok(!cleaned.includes('[3]'));
  assert.ok(!cleaned.includes('Smith et al.'));
  assert.equal(stripCitations('As shown (Lee and Kim, 2018) it works [4, 5].'), 'As shown it works.');
});

test('sentences: abbreviations stay together, long sentences wrap', () => {
  const s = splitSentences('Dr. Smith went home. He slept. J. K. Rowling wrote it.');
  assert.deepEqual(s, ['Dr. Smith went home.', 'He slept.', 'J. K. Rowling wrote it.']);
  const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ') + ', end of clause, and more';
  assert.ok(wrapLong(long, 200).every((p) => p.length <= 200));
});

test('narration: pauses, tables, citations, pronunciations', () => {
  const md = '# Title\n\nFirst sentence. Second one [3].\n\n## Next\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nTable 1. A table caption.';
  const doc = parseStructure(md, { sourceType: 'md' });
  const audiobook = buildUtterances(doc, MODE_PRESETS.audiobook);
  assert.ok(!audiobook.some((u) => u.kind === 'announce' || u.kind === 'table'));
  assert.ok(!audiobook.some((u) => u.spoken.includes('[3]')));
  const idx = audiobook.findIndex((u) => u.text === 'Next');
  assert.ok(audiobook[idx - 1].pauseAfterMs >= MODE_PRESETS.audiobook.sectionPauseMs);
  const study = buildUtterances(doc, MODE_PRESETS.study);
  assert.ok(study.some((u) => u.kind === 'announce' && u.spoken.startsWith('Table with 2 rows')));
  assert.ok(study.some((u) => u.text.startsWith('Table 1.')));
  assert.equal(applyPronunciations('NASA and nasa-tech', [{ term: 'NASA', say: 'nassa' }]), 'nassa and nassa-tech');
});

test('search: exact phrase ranks before loose token match', () => {
  const doc = parseStructure('Alpha beta gamma.\n\nBeta then alpha later.\n\nUnrelated.', { sourceType: 'txt' });
  const hits = searchDocument(doc, 'alpha beta');
  assert.equal(hits.length, 2);
  assert.ok(hits[0].snippet.startsWith('Alpha beta'));
});

test('planChunks covers every utterance once, respects size, prefers section breaks', () => {
  const md = Array.from({ length: 6 }, (_, s) => `## Section ${s}\n\n` + Array.from({ length: 8 }, (_, p) => `Paragraph ${s}-${p} ` + 'word '.repeat(60) + '.').join('\n\n')).join('\n\n');
  const doc = parseStructure(md, { sourceType: 'md' });
  const utts = buildUtterances(doc, MODE_PRESETS.clean);
  const plan = planChunks(utts, 120);
  assert.ok(plan.length > 1);
  assert.equal(plan[0].start, 0);
  assert.equal(plan[plan.length - 1].end, utts.length - 1);
  for (let i = 1; i < plan.length; i++) assert.equal(plan[i].start, plan[i - 1].end + 1);
  assert.equal(chunkIndexFor(plan, 0), 0);
  assert.equal(chunkIndexFor(plan, utts.length - 1), plan.length - 1);
  assert.equal(chunkIndexFor(plan, 99999), -1);
  assert.deepEqual(planChunks([], 120), []);
});

test('audioCacheKey changes when anything audible changes', () => {
  const base = { docId: 'd', docUpdatedAt: 1, provider: 'kokoro', voice: 'af_heart', mode: 'clean', pauseScale: 1, pronunciations: [] as Array<{ term: string; say: string }> };
  const k = audioCacheKey(base);
  assert.equal(k, audioCacheKey({ ...base }));
  for (const change of [{ docUpdatedAt: 2 }, { voice: 'x' }, { mode: 'study' }, { pauseScale: 1.2 }, { pronunciations: [{ term: 'a', say: 'b' }] }, { provider: 'edge' }]) {
    assert.notEqual(k, audioCacheKey({ ...base, ...change }));
  }
});
