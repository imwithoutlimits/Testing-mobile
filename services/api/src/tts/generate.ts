import { audioCacheKey, buildUtterances, estimateSeconds, planChunks, scaledNarration } from '../../../../packages/core/src/index.ts';
import type { ParsedDocument, PronunciationEntry, ReadingMode } from '../../../../packages/core/src/index.ts';
import { HttpError } from '../entitlements.ts';
import { rest, signedUrl, storageDownload, storageUpload } from '../supa.ts';
import { pcmToMp3 } from './ffmpeg.ts';
import { renderChunk } from './render.ts';
import type { TtsEngine } from './types.ts';

export interface ChunkRequest {
  userId: string; docId: string; docUpdatedAt: number; chunkIndex: number;
  engine: TtsEngine; voice: string; mode: ReadingMode; pauseScale: number; prons: PronunciationEntry[];
  beforeSynthesis: (estimatedMinutes: number) => Promise<void>;
}
export interface ChunkResult {
  chunkIndex: number; chunkCount: number; start: number; end: number; durationMs: number;
  items: Array<{ index: number; startMs: number }>; url: string; cached: boolean; cacheKey: string;
}

export async function loadDocument(userId: string, docId: string): Promise<ParsedDocument> {
  const buf = await storageDownload('originals', `${userId}/${docId}/content.json`);
  if (!buf) throw new HttpError(409, 'document_not_synced', 'This document has not finished syncing yet. Wait a moment and try again.');
  return (JSON.parse(buf.toString('utf8')) as { parsed: ParsedDocument }).parsed;
}

export async function generateChunk(r: ChunkRequest): Promise<ChunkResult> {
  const parsed = await loadDocument(r.userId, r.docId);
  const utts = buildUtterances(parsed, scaledNarration(r.mode, r.pauseScale), r.prons);
  const plan = planChunks(utts);
  const range = plan[r.chunkIndex];
  if (!range) throw new HttpError(404, 'no_such_chunk', 'That part of the document does not exist.');

  const cacheKey = audioCacheKey({ docId: r.docId, docUpdatedAt: r.docUpdatedAt, provider: r.engine.id, voice: r.voice, mode: r.mode, pauseScale: r.pauseScale, pronunciations: r.prons });
  const base = `${r.userId}/${r.docId}/${cacheKey}/${range.index}`;
  const side = await storageDownload('audio', `${base}.json`);
  if (side) {
    const meta = JSON.parse(side.toString('utf8')) as { durationMs: number; items: ChunkResult['items'] };
    return { chunkIndex: range.index, chunkCount: plan.length, start: range.start, end: range.end, durationMs: meta.durationMs, items: meta.items, url: await signedUrl('audio', `${base}.mp3`), cached: true, cacheKey };
  }

  const slice = utts.slice(range.start, range.end + 1);
  await r.beforeSynthesis(Math.max(1, Math.ceil(slice.reduce((n, u) => n + estimateSeconds(u), 0) / 60)));
  const rendered = await renderChunk(slice, range.start, r.engine, r.voice);
  const mp3 = await pcmToMp3(rendered.samples, rendered.sampleRate);
  await storageUpload('audio', `${base}.mp3`, mp3, 'audio/mpeg');
  await storageUpload('audio', `${base}.json`, JSON.stringify({ durationMs: rendered.durationMs, items: rendered.items }), 'application/json');
  void rest('audio_assets', { method: 'POST', prefer: 'return=minimal', body: { user_id: r.userId, product: 'earshelf', owner_type: 'document', owner_id: r.docId, storage_path: `${base}.mp3`, provider: r.engine.id, voice_id: r.voice, duration_ms: rendered.durationMs, bytes: mp3.length } }).catch(() => {});
  return { chunkIndex: range.index, chunkCount: plan.length, start: range.start, end: range.end, durationMs: rendered.durationMs, items: rendered.items, url: await signedUrl('audio', `${base}.mp3`), cached: false, cacheKey };
}
