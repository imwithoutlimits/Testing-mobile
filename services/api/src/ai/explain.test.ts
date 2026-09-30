import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStructure } from '../../../../packages/core/src/index.ts';
import { explain, explainContext, FIGURE_NOTE } from './explain.ts';
import type { AiProvider } from './provider.ts';

const md = ['# Report', 'Sales grew in every region last year, led by the north.', 'Table 1. Sales by region', '| Region | 2024 | 2025 |\n|---|---|---|\n| North | 10 | 14 |\n| South | 8 | 9 |', 'The south grew slowly because of supply limits.', 'Figure 2. Monthly trend of sales', 'Sales peaked in December.'].join('\n\n');
const doc = parseStructure(md, { sourceType: 'md' });
const id = (pred: (b: (typeof doc.blocks)[number]) => boolean) => doc.blocks.find(pred)!.id;
const fake = (reply: string): AiProvider => ({ id: 'f', model: 'f', complete: async () => reply });

test('explainContext: table gets rows, caption and surrounding text; figure gets caption and text', () => {
  const t = explainContext(doc, id((b) => b.type === 'table'))!;
  assert.equal(t.kind, 'table'); assert.equal(t.caption, 'Table 1. Sales by region'); assert.equal(t.rows.length, 3);
  assert.ok(t.nearby.includes('south grew slowly'));
  const f = explainContext(doc, id((b) => b.type === 'caption' && /^Figure/.test(b.text)))!;
  assert.equal(f.kind, 'figure'); assert.ok(f.nearby.includes('peaked in December'));
  assert.equal(explainContext(doc, id((b) => b.type === 'paragraph')), null);
  assert.equal(explainContext(doc, 'b9999'), null);
});

test('explain: figures carry an honest note, tables do not; empty output is rejected', async () => {
  const good = JSON.stringify({ explanation: 'The north grew fastest.', keyPoints: ['North +4', 'South +1', '', 7, 'a', 'b', 'c'] });
  const t = await explain(fake(good), doc, id((b) => b.type === 'table'));
  assert.equal(t.note, undefined); assert.equal(t.keyPoints.length, 4);
  const f = await explain(fake(good), doc, id((b) => b.type === 'caption' && /^Figure/.test(b.text)));
  assert.equal(f.note, FIGURE_NOTE);
  await assert.rejects(explain(fake('{"explanation": ""}'), doc, id((b) => b.type === 'table')), /did not return/);
  await assert.rejects(explain(fake(good), doc, id((b) => b.type === 'paragraph')), /nothing to explain/i);
});
