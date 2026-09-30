import type { ParsedDocument } from '../../../../packages/core/src/model.ts';

export interface Passage { id: string; sectionId: string; sectionTitle: string; blockIds: string[]; text: string }

const STOP = new Set('a an and are as at be but by for from has have he her his i if in into is it its of on or she so than that the their them then there these they this to was we were what when where which who why will with you your do does did not can could should would about how'.split(' '));
const tokens = (s: string) => (s.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []).filter((t) => !STOP.has(t));

/** Groups consecutive prose blocks into passages of roughly targetWords, never crossing a section. */
export function buildPassages(doc: ParsedDocument, targetWords = 120): Passage[] {
  const blocks = new Map(doc.blocks.map((b) => [b.id, b]));
  const out: Passage[] = [];
  for (const sec of doc.sections) {
    let cur: Passage | null = null;
    let words = 0;
    const flush = () => { if (cur && cur.text.trim()) out.push(cur); cur = null; words = 0; };
    for (const id of sec.blockIds) {
      const b = blocks.get(id);
      if (!b || b.type === 'heading' || !b.text.trim()) continue;
      if (!cur) cur = { id: `P${out.length + 1}`, sectionId: sec.id, sectionTitle: sec.title, blockIds: [], text: '' };
      cur.blockIds.push(id);
      cur.text += (cur.text ? ' ' : '') + b.text;
      words += b.text.split(/\s+/).length;
      if (words >= targetWords) flush();
    }
    flush();
  }
  return out.map((p, i) => ({ ...p, id: `P${i + 1}` }));
}

/** BM25 ranking. Passages with no matching terms are never returned. */
export function retrieve(passages: Passage[], query: string, k = 6): Passage[] {
  const q = [...new Set(tokens(query))];
  if (!q.length || !passages.length) return [];
  const docs = passages.map((p) => tokens(p.text));
  const avg = docs.reduce((n, d) => n + d.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const N = docs.length, k1 = 1.5, b = 0.75;
  const scored = docs.map((d, i) => {
    const tf = new Map<string, number>();
    d.forEach((t) => tf.set(t, (tf.get(t) ?? 0) + 1));
    let score = 0;
    for (const t of q) {
      const f = tf.get(t) ?? 0;
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg));
    }
    return { p: passages[i], score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b2) => b2.score - a.score).slice(0, k).map((s) => s.p);
}
