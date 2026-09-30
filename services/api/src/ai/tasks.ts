import type { ParsedDocument } from '../../../../packages/core/src/model.ts';
import { parseJson, type AiProvider } from './provider.ts';
import { buildPassages, retrieve, type Passage } from './retrieval.ts';

export const PROMPT_VERSION = 'v1';
const SYSTEM = 'You are a careful reading assistant. Use only the document text you are given. Never invent facts, quotes, numbers or sources. Reply with a single JSON object and nothing else.';

export interface SourceRef { sectionId: string; title: string }

export const SUMMARY_KINDS = {
  '30s': { label: '30-second overview', words: 75 },
  '2min': { label: '2-minute summary', words: 300 },
  '5min': { label: '5-minute summary', words: 750 },
  '10min': { label: '10-minute briefing', words: 1500 },
  executive: { label: 'Executive summary', words: 250 },
  beginner: { label: 'Beginner explanation', words: 350 },
  'key-arguments': { label: 'Key arguments', list: true },
  'action-items': { label: 'Action items', list: true },
  definitions: { label: 'Definitions', list: true },
  statistics: { label: 'Statistics', list: true },
  quotes: { label: 'Notable quotes', list: true },
  'dates-names': { label: 'Dates and names', list: true },
} as const;
export type SummaryKind = keyof typeof SUMMARY_KINDS;
export const isSummaryKind = (k: string): k is SummaryKind => k in SUMMARY_KINDS;

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

function sectionText(doc: ParsedDocument, sectionId: string): string {
  const blocks = new Map(doc.blocks.map((b) => [b.id, b]));
  const sec = doc.sections.find((s) => s.id === sectionId);
  return sec ? sec.blockIds.map((id) => blocks.get(id)?.text ?? '').filter(Boolean).join('\n') : '';
}

function mapSources(doc: ParsedDocument, ids: unknown): SourceRef[] {
  if (!Array.isArray(ids)) return [];
  const byId = new Map(doc.sections.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const id of ids) {
    const s = typeof id === 'string' ? byId.get(id) : undefined;
    if (s && !seen.has(s.id)) { seen.add(s.id); out.push({ sectionId: s.id, title: s.title }); }
  }
  return out;
}

function segments(doc: ParsedDocument, maxWords: number): Array<{ ids: string[]; text: string }> {
  const out: Array<{ ids: string[]; text: string }> = [];
  let cur = { ids: [] as string[], text: '' };
  for (const s of doc.sections) {
    const t = sectionText(doc, s.id);
    if (!t) continue;
    const piece = `[${s.id}] ${s.title}\n${t}`;
    if (cur.ids.length && words(cur.text) + words(piece) > maxWords) { out.push(cur); cur = { ids: [], text: '' }; }
    cur.ids.push(s.id);
    cur.text += (cur.text ? '\n\n' : '') + piece;
  }
  if (cur.ids.length) out.push(cur);
  return out;
}

export interface SummaryResult { kind: SummaryKind; label: string; text: string; items: string[]; sources: SourceRef[] }

export async function summarize(ai: AiProvider, doc: ParsedDocument, kind: SummaryKind): Promise<SummaryResult> {
  const spec = SUMMARY_KINDS[kind];
  const list = 'list' in spec;
  const target = list ? 'a list of at most 12 short items' : `about ${'words' in spec ? spec.words : 300} words of plain prose written to be read aloud`;
  const ask = (body: string) =>
    `Task: ${spec.label}. Produce ${target}.\nSections are labelled like [s0001]. Reply as JSON: {"text": string, "items": string[], "sources": string[]}. "sources" lists the section labels the answer draws on. ${list ? 'Put the list in "items" and leave "text" empty.' : 'Put the prose in "text" and leave "items" empty.'}\n\nDOCUMENT:\n${body}`;

  const segs = segments(doc, 3500);
  if (!segs.length) throw new Error('This document has no readable text to summarize.');
  let body: string;
  if (segs.length === 1 || segs.reduce((n, s) => n + words(s.text), 0) <= 6000) body = segs.map((s) => s.text).join('\n\n');
  else {
    const notes: string[] = [];
    for (const s of segs) {
      const raw = await ai.complete(SYSTEM, `Write concise factual notes (under 200 words) on this part. Keep the section labels you rely on in the notes. Reply as JSON: {"text": string}.\n\n${s.text}`, { maxTokens: 500 });
      const j = parseJson<{ text?: string }>(raw);
      if (j?.text) notes.push(`(sections ${s.ids[0]} to ${s.ids[s.ids.length - 1]}) ${j.text}`);
    }
    body = notes.join('\n\n');
  }
  const j = parseJson<{ text?: string; items?: unknown; sources?: unknown }>(await ai.complete(SYSTEM, ask(body), { maxTokens: list ? 1200 : Math.round(('words' in spec ? spec.words : 300) * 2) + 200 }));
  if (!j) throw new Error('The AI reply could not be read. Try again.');
  const items = Array.isArray(j.items) ? j.items.filter((x): x is string => typeof x === 'string' && !!x.trim()).slice(0, 12) : [];
  const text = typeof j.text === 'string' ? j.text.trim() : '';
  if (!text && !items.length) throw new Error('The AI returned an empty answer. Try again.');
  return { kind, label: spec.label, text, items, sources: mapSources(doc, j.sources) };
}

export interface AskResult { found: boolean; answer: string; citations: Array<{ passage: string; sectionId: string; sectionTitle: string; blockId: string; snippet: string }> }

export async function ask(ai: AiProvider, doc: ParsedDocument, question: string): Promise<AskResult> {
  const passages = retrieve(buildPassages(doc), question, 6);
  const notFound: AskResult = { found: false, answer: 'This document does not seem to cover that.', citations: [] };
  if (!passages.length) return notFound;
  const ctx = passages.map((p) => `[${p.id}] (${p.sectionTitle}) ${p.text}`).join('\n\n');
  const raw = await ai.complete(SYSTEM, `Answer the question using only the passages below. If they do not contain the answer, set "found" to false. Cite the passages you used.\nReply as JSON: {"found": boolean, "answer": string, "citations": string[]}.\n\nQUESTION: ${question}\n\nPASSAGES:\n${ctx}`, { maxTokens: 700 });
  const j = parseJson<{ found?: boolean; answer?: string; citations?: unknown }>(raw);
  if (!j || j.found === false || typeof j.answer !== 'string' || !j.answer.trim()) return notFound;
  const byId = new Map(passages.map((p) => [p.id, p]));
  const cited = (Array.isArray(j.citations) ? j.citations : []).map((c) => (typeof c === 'string' ? byId.get(c) : undefined)).filter((p): p is Passage => !!p);
  // An answer with no valid citation cannot be checked against the document, so it is not shown as fact.
  if (!cited.length) return { found: false, answer: 'I could not tie an answer to a specific place in this document.', citations: [] };
  return {
    found: true, answer: j.answer.trim(),
    citations: [...new Set(cited)].map((p) => ({ passage: p.id, sectionId: p.sectionId, sectionTitle: p.sectionTitle, blockId: p.blockIds[0], snippet: p.text.slice(0, 160) })),
  };
}

export interface QuizQuestion { type: 'mcq' | 'tf' | 'fill'; question: string; options?: string[]; answer: string | number | boolean; explanation: string; blockId: string }
export interface Flashcard { front: string; back: string; blockId: string }

function pickPassages(doc: ParsedDocument, sectionId: string | undefined, max: number): Passage[] {
  let ps = buildPassages(doc);
  if (sectionId) ps = ps.filter((p) => p.sectionId === sectionId);
  if (ps.length <= max) return ps;
  const step = ps.length / max;
  return Array.from({ length: max }, (_, i) => ps[Math.floor(i * step)]);
}

export function validateQuiz(raw: unknown, passages: Passage[]): QuizQuestion[] {
  if (!Array.isArray(raw)) return [];
  const byId = new Map(passages.map((p) => [p.id, p]));
  const out: QuizQuestion[] = [];
  for (const q of raw as Array<Record<string, unknown>>) {
    const type = q?.type, question = q?.question, explanation = q?.explanation, src = typeof q?.source === 'string' ? byId.get(q.source) : undefined;
    if (!src || typeof question !== 'string' || !question.trim() || typeof explanation !== 'string') continue;
    if (type === 'mcq') {
      const opts = q.options, ans = q.answer;
      if (Array.isArray(opts) && opts.length === 4 && opts.every((o) => typeof o === 'string' && o.trim()) && Number.isInteger(ans) && (ans as number) >= 0 && (ans as number) < 4)
        out.push({ type, question, options: opts as string[], answer: ans as number, explanation, blockId: src.blockIds[0] });
    } else if (type === 'tf') {
      if (typeof q.answer === 'boolean') out.push({ type, question, answer: q.answer, explanation, blockId: src.blockIds[0] });
    } else if (type === 'fill') {
      if (typeof q.answer === 'string' && q.answer.trim() && question.includes('____')) out.push({ type, question, answer: q.answer.trim(), explanation, blockId: src.blockIds[0] });
    }
  }
  return out;
}

export async function quiz(ai: AiProvider, doc: ParsedDocument, opts: { sectionId?: string; count: number }): Promise<QuizQuestion[]> {
  const passages = pickPassages(doc, opts.sectionId, 12);
  if (!passages.length) throw new Error('There is not enough text here to make questions.');
  const ctx = passages.map((p) => `[${p.id}] ${p.text}`).join('\n\n');
  const raw = await ai.complete(SYSTEM, `Write ${opts.count} quiz questions that test understanding of the passages. Mix types. Each item: {"type":"mcq"|"tf"|"fill","question":string,"options":string[4] (mcq only),"answer": (mcq: index 0-3, tf: true/false, fill: the missing word or phrase),"explanation":string,"source":"P#"}. Fill questions must contain ____ where the answer goes.\nReply as JSON: {"questions": [...]}.\n\nPASSAGES:\n${ctx}`, { maxTokens: 2000 });
  const valid = validateQuiz(parseJson<{ questions?: unknown }>(raw)?.questions, passages).slice(0, opts.count);
  if (!valid.length) throw new Error('The AI did not return usable questions. Try again.');
  return valid;
}

export async function flashcards(ai: AiProvider, doc: ParsedDocument, opts: { sectionId?: string; count: number }): Promise<Flashcard[]> {
  const passages = pickPassages(doc, opts.sectionId, 12);
  if (!passages.length) throw new Error('There is not enough text here to make flashcards.');
  const byId = new Map(passages.map((p) => [p.id, p]));
  const ctx = passages.map((p) => `[${p.id}] ${p.text}`).join('\n\n');
  const raw = await ai.complete(SYSTEM, `Write ${opts.count} flashcards for the key terms and ideas. Each: {"front":string,"back":string,"source":"P#"}. Reply as JSON: {"cards": [...]}.\n\nPASSAGES:\n${ctx}`, { maxTokens: 1500 });
  const cards = (parseJson<{ cards?: Array<Record<string, unknown>> }>(raw)?.cards ?? [])
    .map((c) => ({ front: c.front, back: c.back, src: typeof c.source === 'string' ? byId.get(c.source) : undefined }))
    .filter((c): c is { front: string; back: string; src: Passage } => typeof c.front === 'string' && !!c.front.trim() && typeof c.back === 'string' && !!c.back.trim() && !!c.src)
    .map((c) => ({ front: c.front, back: c.back, blockId: c.src.blockIds[0] }));
  if (!cards.length) throw new Error('The AI did not return usable flashcards. Try again.');
  return cards.slice(0, opts.count);
}
