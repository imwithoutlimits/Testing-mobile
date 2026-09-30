import { buildUtterances, planChunks, scaledNarration } from '../../../packages/core/src/index.ts';
import type { PronunciationEntry, ReadingMode } from '../../../packages/core/src/index.ts';
import { HttpError } from './entitlements.ts';
import { runExport } from './export.ts';
import { generateChunk, loadDocument } from './tts/generate.ts';
import { packageAudio } from './tts/package.ts';
import { rest, signedUrl, storageDownload, storageUpload } from './supa.ts';
import type { TtsEngine } from './tts/types.ts';
import { report } from './monitor.ts';

let active = 0;
const ACTIVE_STATES = ['queued', 'generating', 'packaging'];

export interface ExportRequest {
  userId: string; docId: string; docUpdatedAt: number; engine: TtsEngine; voice: string; mode: ReadingMode; pauseScale: number;
  prons: PronunciationEntry[]; format: 'mp3' | 'm4b'; beforeSynthesis: (minutes: number) => Promise<void>;
}

export async function startExport(r: ExportRequest): Promise<string> {
  const running = await rest<Array<{ id: string; updated_at: string }>>(`processing_jobs?user_id=eq.${r.userId}&kind=eq.audio_export&state=in.(${ACTIVE_STATES.join(',')})&select=id,updated_at`);
  const live = running.find((j) => Date.now() - Date.parse(j.updated_at) < 15 * 60_000);
  if (live) return live.id; // one export at a time per person
  if (active >= 2) throw new HttpError(503, 'busy', 'The server is preparing other exports right now. Try again in a few minutes.');

  const parsed = await loadDocument(r.userId, r.docId);
  const utts = buildUtterances(parsed, scaledNarration(r.mode, r.pauseScale), r.prons);
  const plan = planChunks(utts);
  if (!plan.length) throw new HttpError(422, 'nothing_to_export', 'This document has no readable text to export.');

  const [job] = await rest<Array<{ id: string }>>('processing_jobs', { method: 'POST', body: { user_id: r.userId, product: 'earshelf', kind: 'audio_export', subject_id: r.docId, state: 'queued', progress: 0, provider: r.engine.id } });
  const patch = async (p: { state?: string; progress?: number; error?: string; result?: Record<string, unknown> }) => {
    await rest(`processing_jobs?id=eq.${job.id}`, { method: 'PATCH', prefer: 'return=minimal', body: p });
  };
  const titles: Record<string, string> = {};
  parsed.sections.forEach((s) => { titles[s.id] = s.title; });

  active++;
  void runExport({
    chunkCount: plan.length, utterances: utts, titles, docTitle: parsed.title, author: parsed.author, format: r.format, setJob: patch,
    async generate(ci) {
      const c = await generateChunk({ userId: r.userId, docId: r.docId, docUpdatedAt: r.docUpdatedAt, chunkIndex: ci, engine: r.engine, voice: r.voice, mode: r.mode, pauseScale: r.pauseScale, prons: r.prons, beforeSynthesis: r.beforeSynthesis });
      const mp3 = await storageDownload('audio', `${r.userId}/${r.docId}/${c.cacheKey}/${ci}.mp3`);
      if (!mp3) throw new Error('A generated part went missing. Try the export again.');
      return { meta: { start: c.start, end: c.end, durationMs: c.durationMs, items: c.items }, mp3 };
    },
    packageAudio,
    async upload(buffer, ext) {
      const path = `${r.userId}/${r.docId}/exports/${Date.now()}.${ext}`;
      await storageUpload('audio', path, buffer, ext === 'm4b' ? 'audio/mp4' : 'audio/mpeg');
      return path;
    },
  }).catch((e) => report(e, 'export')).finally(() => { active--; });
  return job.id;
}

export async function jobStatus(userId: string, id: string) {
  const rows = await rest<Array<{ id: string; state: string; progress: number | null; error: string | null; result: { path?: string; ext?: string; bytes?: number; durationMs?: number; chapters?: number } | null; updated_at: string }>>(
    `processing_jobs?id=eq.${encodeURIComponent(id)}&user_id=eq.${userId}&select=id,state,progress,error,result,updated_at`);
  const j = rows[0];
  if (!j) throw new HttpError(404, 'no_such_job', 'That export was not found.');
  const stale = ACTIVE_STATES.includes(j.state) && Date.now() - Date.parse(j.updated_at) > 15 * 60_000;
  return {
    id: j.id, state: stale ? 'failed' : j.state, progress: j.progress ?? 0,
    error: stale ? 'The export was interrupted. Start it again; parts already made are reused.' : j.error,
    result: j.state === 'ready' && j.result?.path ? { url: await signedUrl('audio', j.result.path), ext: j.result.ext, bytes: j.result.bytes, durationMs: j.result.durationMs, chapters: j.result.chapters } : null,
  };
}
