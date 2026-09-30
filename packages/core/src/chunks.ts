import type { Utterance } from './model.ts';

export interface ChunkRange { index: number; start: number; end: number } // end is inclusive

const WORDS_PER_SECOND = 2.6;

export function estimateSeconds(u: Utterance): number {
  const words = u.spoken.split(/\s+/).filter(Boolean).length;
  return words / WORDS_PER_SECOND + u.pauseAfterMs / 1000;
}

/**
 * Splits the utterance list into audio chunks of roughly maxSeconds, preferring section boundaries.
 * Client and server both call this, so chunk numbers always mean the same thing.
 */
export function planChunks(items: Utterance[], maxSeconds = 240): ChunkRange[] {
  const out: ChunkRange[] = [];
  let start = 0;
  let acc = 0;
  for (let i = 0; i < items.length; i++) {
    const sec = estimateSeconds(items[i]);
    const count = i - start;
    const newSection = i > 0 && items[i].sectionId !== items[i - 1].sectionId;
    if (count > 0 && (acc + sec > maxSeconds || (newSection && acc >= maxSeconds * 0.6))) {
      out.push({ index: out.length, start, end: i - 1 });
      start = i;
      acc = 0;
    }
    acc += sec;
  }
  if (items.length) out.push({ index: out.length, start, end: items.length - 1 });
  return out;
}

export function chunkIndexFor(plan: ChunkRange[], utteranceIndex: number): number {
  const c = plan.find((p) => utteranceIndex >= p.start && utteranceIndex <= p.end);
  return c ? c.index : -1;
}

export interface AudioKeyParams {
  docId: string;
  docUpdatedAt: number;
  provider: string;
  voice: string;
  mode: string;
  pauseScale: number;
  pronunciations: Array<{ term: string; say: string }>;
}

/** Any change that would change the audio changes the key, so stale audio is never reused. */
export function audioCacheKey(p: AudioKeyParams): string {
  const s = JSON.stringify([p.docId, p.docUpdatedAt, p.provider, p.voice, p.mode, Math.round(p.pauseScale * 100), [...p.pronunciations].sort((a, b) => a.term.localeCompare(b.term)).map((x) => [x.term, x.say])]);
  let h1 = 5381, h2 = 52711;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = ((h1 * 33) ^ c) >>> 0; h2 = ((h2 * 33) ^ c) >>> 0; }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}
