import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStructure } from '../../../../packages/core/src/index.ts';
import { parseJson, type AiProvider } from './provider.ts';
import { buildPassages, retrieve } from './retrieval.ts';
import { ask, summarize, quiz, validateQuiz } from './tasks.ts';
import { isPrivateIp } from '../article.ts';

const doc = parseStructure([
  '# Coffee', '## Origins', 'Coffee was first cultivated in Ethiopia and later spread across Yemen and the wider Arabian peninsula by traders.',
  '## Brewing', 'Espresso is brewed by forcing hot water through finely ground coffee at high pressure, producing a concentrated shot with crema.',
  'Cold brew steeps coarse grounds in cold water for twelve to twenty four hours.', '## Health', 'Moderate coffee intake is associated with lower risk of some conditions in observational studies.',
].join('\n\n'), { sourceType: 'md' });
const sec = (t: string) => doc.sections.find((s) => s.title === t)!.id;

function fake(reply: (system: string, user: string) => string): AiProvider & { calls: number } {
  const p = { id: 'fake', model: 'fake', calls: 0, complete: async (s: string, u: string) => { p.calls++; return reply(s, u); } };
  return p;
}

test('parseJson tolerates fences and chatter', () => {
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJson('Sure! {"a": [1,2]} hope that helps'), { a: [1, 2] });
  assert.equal(parseJson('no json here'), null);
});

test('retrieval ranks the relevant passage first and returns nothing for unrelated queries', () => {
  const ps = buildPassages(doc, 20);
  assert.equal(retrieve(ps, 'how is espresso brewed under pressure')[0].sectionTitle, 'Brewing');
  assert.equal(retrieve(ps, 'where did coffee originate Ethiopia')[0].sectionTitle, 'Origins');
  assert.deepEqual(retrieve(ps, 'quantum chromodynamics'), []);
});

test('ask: not-found never calls the model; invalid citations are rejected; valid ones link to the source', async () => {
  const never = fake(() => { throw new Error('should not be called'); });
  const r0 = await ask(never, doc, 'quantum chromodynamics');
  assert.equal(r0.found, false);
  assert.equal(never.calls, 0);

  const uncited = fake(() => JSON.stringify({ found: true, answer: 'Made up.', citations: ['P99'] }));
  assert.equal((await ask(uncited, doc, 'how is espresso brewed')).found, false);

  const good = fake(() => JSON.stringify({ found: true, answer: 'Hot water is forced through fine grounds.', citations: ['P2', 'P404'] }));
  const r = await ask(good, doc, 'how is espresso brewed');
  assert.equal(r.found, true);
  assert.ok(r.citations.length >= 1 && r.citations.every((c) => c.blockId && c.sectionId));
});

test('summarize: unknown section ids are dropped, empty answers rejected', async () => {
  const ai = fake(() => JSON.stringify({ text: 'Coffee spread from Ethiopia.', items: [], sources: [sec('Origins'), 's9999'] }));
  const s = await summarize(ai, doc, '30s');
  assert.deepEqual(s.sources.map((x) => x.title), ['Origins']);
  await assert.rejects(summarize(fake(() => JSON.stringify({ text: '', items: [] })), doc, '30s'));
  const list = await summarize(fake(() => JSON.stringify({ text: '', items: ['One', '', 5, 'Two'], sources: [] })), doc, 'key-arguments');
  assert.deepEqual(list.items, ['One', 'Two']);
});

test('quiz validation keeps only well-formed questions with a real source', () => {
  const ps = buildPassages(doc, 20);
  const src = ps[0].id;
  const raw = [
    { type: 'mcq', question: 'Q1?', options: ['a', 'b', 'c', 'd'], answer: 2, explanation: 'e', source: src },
    { type: 'mcq', question: 'Bad options', options: ['a', 'b'], answer: 0, explanation: 'e', source: src },
    { type: 'mcq', question: 'Bad answer', options: ['a', 'b', 'c', 'd'], answer: 7, explanation: 'e', source: src },
    { type: 'tf', question: 'True?', answer: true, explanation: 'e', source: src },
    { type: 'tf', question: 'No source', answer: true, explanation: 'e', source: 'P404' },
    { type: 'fill', question: 'Coffee came from ____.', answer: 'Ethiopia', explanation: 'e', source: src },
    { type: 'fill', question: 'Missing blank', answer: 'x', explanation: 'e', source: src },
  ];
  assert.equal(validateQuiz(raw, ps).length, 3);
  assert.deepEqual(validateQuiz('nope', ps), []);
});

test('quiz: throws a clear error when the model returns nothing usable', async () => {
  await assert.rejects(quiz(fake(() => '{"questions": []}'), doc, { count: 5 }), /usable questions/);
});

test('SSRF guard blocks private and loopback addresses', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.16.5.5', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1', '0.0.0.0']) assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) assert.equal(isPrivateIp(ip), false, ip);
});
