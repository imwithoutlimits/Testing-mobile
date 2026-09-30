import type { ParsedDocument } from './model.ts';

export interface SearchHit {
  blockId: string;
  sectionId: string;
  snippet: string;
}

export function searchDocument(doc: ParsedDocument, query: string, limit = 50): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const tokens = q.split(/\s+/).filter(Boolean);
  const sectionOf = new Map<string, string>();
  doc.sections.forEach((s) => s.blockIds.forEach((id) => sectionOf.set(id, s.id)));

  const exact: SearchHit[] = [];
  const loose: SearchHit[] = [];
  for (const b of doc.blocks) {
    const lower = b.text.toLowerCase();
    const at = lower.indexOf(q);
    const hitAt = at >= 0 ? at : tokens.every((t) => lower.includes(t)) ? lower.indexOf(tokens[0]) : -1;
    if (hitAt < 0) continue;
    const start = Math.max(0, hitAt - 60);
    const end = Math.min(b.text.length, hitAt + q.length + 80);
    const hit: SearchHit = {
      blockId: b.id,
      sectionId: sectionOf.get(b.id) ?? '',
      snippet: `${start > 0 ? '…' : ''}${b.text.slice(start, end)}${end < b.text.length ? '…' : ''}`,
    };
    (at >= 0 ? exact : loose).push(hit);
  }
  return [...exact, ...loose].slice(0, limit);
}
