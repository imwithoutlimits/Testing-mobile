import type { ParsedDocument } from '../../../packages/core/src/model.ts';
import { buildPassages } from './ai/retrieval.ts';
import { config } from './config.ts';
import { rest } from './supa.ts';

export interface Embedder { model: string; dims: number; embed(texts: string[]): Promise<number[][]> }

/** Any OpenAI-style /embeddings endpoint. Returns null when none is configured, so meaning search switches off cleanly. */
export function makeEmbedder(cfg = config.embed, f: typeof fetch = fetch): Embedder | null {
  if (!cfg.key && !cfg.base) return null;
  return {
    model: cfg.model, dims: cfg.dims,
    async embed(texts) {
      const res = await f(`${cfg.base || 'https://api.openai.com/v1'}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}) },
        body: JSON.stringify({ model: cfg.model, input: texts, dimensions: cfg.dims }),
      });
      if (!res.ok) throw new Error(`The embedding service returned ${res.status}.`);
      const data = ((await res.json()) as { data?: Array<{ index: number; embedding: number[] }> }).data ?? [];
      const out = [...data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
      if (out.length !== texts.length) throw new Error('The embedding service returned the wrong number of results.');
      const bad = out.find((v) => v.length !== cfg.dims);
      if (bad) throw new Error(`The embedding model returns ${bad.length} numbers per passage but the database expects ${cfg.dims}. Use a ${cfg.dims}-dimension model, or one that supports a "dimensions" setting.`);
      return out;
    },
  };
}

export const batches = <T,>(a: T[], n: number): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, (i + 1) * n));
const vec = (v: number[]) => `[${v.join(',')}]`;

export interface ChunkRow {
  user_id: string; document_id: string; content: string; block_refs: string[]; section_ref: string; section_title: string;
  position: number; doc_version: number; embedding: string;
}
export interface IndexDeps { embed(texts: string[]): Promise<number[][]>; replace(userId: string, documentId: string, rows: ChunkRow[]): Promise<void> }

export async function indexDocument(deps: IndexDeps, doc: ParsedDocument, o: { userId: string; documentId: string; version: number }): Promise<number> {
  const passages = buildPassages(doc, 120);
  const rows: ChunkRow[] = [];
  for (const group of batches(passages, 64)) {
    // The section title is part of what is embedded, so "Espresso" in a chapter about brewing finds the right place.
    const vectors = await deps.embed(group.map((p) => `${p.sectionTitle}\n${p.text}`));
    group.forEach((p, i) => rows.push({ user_id: o.userId, document_id: o.documentId, content: p.text, block_refs: p.blockIds, section_ref: p.sectionId, section_title: p.sectionTitle, position: rows.length, doc_version: o.version, embedding: vec(vectors[i]) }));
  }
  await deps.replace(o.userId, o.documentId, rows); // old chunks are removed only after the new ones are ready
  return rows.length;
}

export async function replaceChunks(userId: string, documentId: string, rows: ChunkRow[]): Promise<void> {
  await rest(`document_chunks?document_id=eq.${documentId}&user_id=eq.${userId}`, { method: 'DELETE', prefer: 'return=minimal' });
  for (const b of batches(rows, 50)) await rest('document_chunks', { method: 'POST', prefer: 'return=minimal', body: b });
}

export interface SearchHit { documentId: string; blockId: string; sectionTitle: string; snippet: string; score: number }
export interface SearchDeps { embed(texts: string[]): Promise<number[][]>; rpc(params: Record<string, unknown>): Promise<Array<{ document_id: string; content: string; block_refs: string[]; section_title: string; score: number }>> }

export async function semanticSearch(deps: SearchDeps, o: { userId: string; query: string; documentId?: string; limit?: number }): Promise<SearchHit[]> {
  const [q] = await deps.embed([o.query]);
  const rows = await deps.rpc({ p_user: o.userId, p_query: o.query, p_embedding: vec(q), p_limit: o.limit ?? 12, p_document: o.documentId ?? null });
  return rows.map((r) => ({ documentId: r.document_id, blockId: r.block_refs?.[0] ?? '', sectionTitle: r.section_title ?? '', snippet: r.content.slice(0, 180), score: r.score }));
}
export const realSearchRpc: SearchDeps['rpc'] = (params) => rest('rpc/hybrid_search', { method: 'POST', body: params });
