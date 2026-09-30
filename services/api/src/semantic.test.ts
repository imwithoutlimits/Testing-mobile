import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStructure } from '../../../packages/core/src/index.ts';
import { batches, indexDocument, makeEmbedder, semanticSearch, type ChunkRow } from './semantic.ts';

const doc = parseStructure(['# Coffee', '## Origins', 'Coffee was first cultivated in Ethiopia and spread across Yemen.', '## Brewing', 'Espresso forces hot water through fine grounds under pressure.'].join('\n\n'), { sourceType: 'md' });
const DIMS = 384;
const vector = (seed: number) => Array.from({ length: DIMS }, (_, i) => (i === seed % DIMS ? 1 : 0));

test('batches splits evenly and keeps order', () => {
  assert.deepEqual(batches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(batches([], 3), []);
});

test('embedder: off without config; checks count and dimensions; sorts by index', async () => {
  assert.equal(makeEmbedder({ base: '', key: '', model: 'm', dims: DIMS }), null);
  const cfg = { base: 'http://x/v1', key: 'k', model: 'm', dims: DIMS };
  const ok = makeEmbedder(cfg, (async () => new Response(JSON.stringify({ data: [{ index: 1, embedding: vector(2) }, { index: 0, embedding: vector(1) }] }))) as unknown as typeof fetch)!;
  const out = await ok.embed(['a', 'b']);
  assert.equal(out[0][1], 1); assert.equal(out[1][2], 1);
  const wrongDims = makeEmbedder(cfg, (async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3] }] }))) as unknown as typeof fetch)!;
  await assert.rejects(wrongDims.embed(['a']), /expects 384/);
  const wrongCount = makeEmbedder(cfg, (async () => new Response(JSON.stringify({ data: [] }))) as unknown as typeof fetch)!;
  await assert.rejects(wrongCount.embed(['a']), /wrong number/);
});

test('indexDocument embeds section title with text, replaces chunks only after embedding succeeds', async () => {
  const texts: string[] = [];
  let replaced: ChunkRow[] | null = null;
  const n = await indexDocument({
    embed: async (t) => { texts.push(...t); return t.map((_, i) => vector(i)); },
    replace: async (_u, _d, rows) => { replaced = rows; },
  }, doc, { userId: 'u1', documentId: 'd1', version: 7 });
  assert.equal(n, 2);
  assert.ok(texts[0].startsWith('Origins\n') && texts[1].startsWith('Brewing\n'));
  const rows = replaced as unknown as ChunkRow[];
  assert.deepEqual(rows.map((r) => [r.section_title, r.position, r.doc_version, r.user_id]), [['Origins', 0, 7, 'u1'], ['Brewing', 1, 7, 'u1']]);
  assert.ok(rows[0].embedding.startsWith('[') && rows[0].block_refs.length >= 1);

  let called = false;
  await assert.rejects(indexDocument({ embed: async () => { throw new Error('quota'); }, replace: async () => { called = true; } }, doc, { userId: 'u', documentId: 'd', version: 1 }), /quota/);
  assert.equal(called, false); // a failed re-index never wipes the old index
});

test('semanticSearch sends the user and vector, maps rows to hits', async () => {
  let params: Record<string, unknown> = {};
  const hits = await semanticSearch({
    embed: async () => [vector(5)],
    rpc: async (p) => { params = p; return [{ document_id: 'd1', content: 'x'.repeat(300), block_refs: ['b0003', 'b0004'], section_title: 'Brewing', score: 0.03 }]; },
  }, { userId: 'u1', query: 'how is espresso made', documentId: 'd1' });
  assert.equal(params.p_user, 'u1'); assert.equal(params.p_document, 'd1');
  assert.ok(String(params.p_embedding).startsWith('[0,0,0,0,0,1'));
  assert.deepEqual([hits[0].documentId, hits[0].blockId, hits[0].sectionTitle, hits[0].snippet.length], ['d1', 'b0003', 'Brewing', 180]);
});
