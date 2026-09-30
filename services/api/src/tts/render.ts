import type { Utterance } from '../../../../packages/core/src/model.ts';
import { stitch } from './pcm.ts';
import type { TtsEngine } from './types.ts';

export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  });
  await Promise.all(workers);
  return out;
}

export interface RenderedChunk { samples: Int16Array; items: Array<{ index: number; startMs: number }>; durationMs: number; sampleRate: number }

/** Speaks each utterance, then stitches them with the planned pauses. Indices are positions in the full utterance list. */
export async function renderChunk(utts: Utterance[], firstIndex: number, engine: TtsEngine, voice: string, concurrency: number = engine.concurrency ?? 4): Promise<RenderedChunk> {
  const clips = await mapPool(utts, concurrency, (u, i) => engine.synthesize(u.spoken, voice, { previous: utts[i - 1]?.spoken, next: utts[i + 1]?.spoken }));
  const rate = clips[0]?.sampleRate ?? 24000;
  if (clips.some((c) => c.sampleRate !== rate)) throw new Error('The voice engine returned mixed sample rates.');
  const s = stitch(clips.map((c, i) => ({ samples: c.samples, pauseAfterMs: utts[i].pauseAfterMs })), rate);
  return { samples: s.samples, items: s.startMs.map((startMs, i) => ({ index: firstIndex + i, startMs })), durationMs: s.durationMs, sampleRate: rate };
}
