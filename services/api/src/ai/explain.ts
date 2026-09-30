import type { DocBlock, ParsedDocument } from '../../../../packages/core/src/model.ts';
import { parseJson, type AiProvider } from './provider.ts';

export interface ExplainContext { kind: 'table' | 'figure'; caption: string; rows: string[][]; nearby: string }
export const FIGURE_NOTE = 'Based on the caption and the text around it. The image itself was not analyzed.';

const isCaption = (b?: DocBlock) => !!b && b.type === 'caption';
const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Gathers what the model is allowed to use: the table's cells, its caption, and the paragraphs around it. */
export function explainContext(doc: ParsedDocument, blockId: string): ExplainContext | null {
  const i = doc.blocks.findIndex((b) => b.id === blockId);
  const b = doc.blocks[i];
  if (!b) return null;
  const isTable = b.type === 'table';
  const isFigure = b.type === 'caption' && /^(figure|fig\.)\s+\d+/i.test(b.text);
  if (!isTable && !isFigure) return null;
  const caption = isTable ? [doc.blocks[i - 1], doc.blocks[i + 1]].find((x) => isCaption(x) && /^table\s+\d+/i.test(x!.text))?.text ?? '' : b.text;
  const around = [...doc.blocks.slice(Math.max(0, i - 3), i), ...doc.blocks.slice(i + 1, i + 4)].filter((x) => x.type === 'paragraph');
  return {
    kind: isTable ? 'table' : 'figure', caption,
    rows: isTable ? (b.rows ?? []).slice(0, 30).map((r) => r.slice(0, 12)) : [],
    nearby: trim(around.map((x) => x.text).join('\n'), 1400),
  };
}

export interface Explanation { kind: 'table' | 'figure'; explanation: string; keyPoints: string[]; note?: string }

const SYSTEM = 'You explain tables and figures to someone who is listening, not looking. Use only the material provided. Never invent numbers, trends or details. Reply with a single JSON object and nothing else.';

export async function explain(ai: AiProvider, doc: ParsedDocument, blockId: string): Promise<Explanation> {
  const c = explainContext(doc, blockId);
  if (!c) throw new Error('There is nothing to explain at that spot. Try a table or a captioned figure.');
  const material = c.kind === 'table'
    ? `TABLE${c.caption ? ` (${c.caption})` : ''}\n${c.rows.map((r) => r.join(' | ')).join('\n')}\n\nSURROUNDING TEXT\n${c.nearby || '(none)'}`
    : `FIGURE CAPTION: ${c.caption}\n\nSURROUNDING TEXT\n${c.nearby || '(none)'}\n\nYou cannot see the image. Explain only what the caption and text say. Say plainly if they do not describe what the figure shows.`;
  const raw = await ai.complete(SYSTEM, `Explain this ${c.kind} in plain spoken language: what it shows, the most important comparison or takeaway, and anything to be careful about. Under 180 words. Then list up to 4 key points.\nReply as JSON: {"explanation": string, "keyPoints": string[]}.\n\n${material}`, { maxTokens: 700 });
  const j = parseJson<{ explanation?: unknown; keyPoints?: unknown }>(raw);
  const text = typeof j?.explanation === 'string' ? j.explanation.trim() : '';
  if (!text) throw new Error('The AI did not return an explanation. Try again.');
  const keyPoints = Array.isArray(j?.keyPoints) ? j!.keyPoints.filter((k): k is string => typeof k === 'string' && !!k.trim()).slice(0, 4) : [];
  return { kind: c.kind, explanation: text.slice(0, 1500), keyPoints, note: c.kind === 'figure' ? FIGURE_NOTE : undefined };
}
