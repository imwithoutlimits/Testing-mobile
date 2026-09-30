import { useEffect, useState } from 'react';
import { audioCacheKey, chunkIndexFor, planChunks } from '@wells/core';
import type { ChunkRange, Utterance } from '@wells/core';
import type { AudioChunk } from '@wells/audio-player';
import { hasFeature } from '@wells/billing/src/plans.ts';
import { apiGet, apiPost, apiUrl, supabase } from './supabase';
import { db, getSetting, type DocRecord } from './db';
import { ensureDocumentSynced } from './sync';
import { currentPlan, player } from './hooks';

interface ChunkResponse { chunkIndex: number; chunkCount: number; durationMs: number; items: AudioChunk['items']; url: string; cacheKey: string }
export interface Capabilities { plan: string; engines: Array<{ id: string; label: string; commercialUseAllowed: boolean }>; ai: boolean; embeddings: boolean }
export interface VoiceInfo { id: string; name: string; lang: string }

let active: { doc: DocRecord; utterances: Utterance[]; plan: ChunkRange[]; scale: number; prons: Array<{ term: string; say: string }> } | null = null;
const loaded = new Map<number, AudioChunk>();
let loadedKey = '';
const inflight = new Map<string, Promise<AudioChunk>>();
const blobUrls = new Map<string, string>();

const blobUrl = (key: string, blob: Blob) => { let u = blobUrls.get(key); if (!u) { u = URL.createObjectURL(blob); blobUrls.set(key, u); } return u; };

async function voiceSettings() {
  return { on: await getSetting('useServerVoice', false), provider: await getSetting('ttsProvider', ''), voice: await getSetting('ttsVoice', '') };
}

/** Tells the natural-voice layer which document is loaded in the player. */
export async function registerDocument(doc: DocRecord, utterances: Utterance[], scale: number) {
  const plan = await currentPlan();
  const prons = hasFeature(plan, 'pronunciation') ? (await db.pron.toArray()).filter((p) => !p.docId || p.docId === doc.id).map((p) => ({ term: p.term, say: p.say })) : [];
  active = { doc, utterances, plan: planChunks(utterances), scale, prons };
  loaded.clear(); loadedKey = '';
}

function keyFor(provider: string, voice: string): string {
  const a = active!;
  return audioCacheKey({ docId: a.doc.id, docUpdatedAt: a.doc.updatedAt, provider, voice, mode: a.doc.readingMode, pauseScale: a.scale, pronunciations: a.prons });
}

async function ensureChunk(ci: number, persist = false): Promise<AudioChunk> {
  const a = active;
  if (!a) throw new Error('No document is loaded.');
  const { provider, voice } = await voiceSettings();
  const key = keyFor(provider, voice);
  if (key !== loadedKey) { loaded.clear(); loadedKey = key; }
  const have = loaded.get(ci);
  const local = await db.audio.get(`${key}:${ci}`);
  if (local) { const c = { url: blobUrl(local.key, local.blob), items: local.items, durationMs: local.durationMs }; loaded.set(ci, c); return c; }
  if (have && !persist) return have;
  const flight = `${key}:${ci}:${persist}`;
  const running = inflight.get(flight);
  if (running) return running;
  const p = (async () => {
    await ensureDocumentSynced(a.doc.id);
    const r = await apiPost<ChunkResponse>('/v1/chunks', { documentId: a.doc.id, updatedAt: a.doc.updatedAt, chunkIndex: ci, provider, voice, mode: a.doc.readingMode, pauseScale: a.scale, pronunciations: a.prons });
    let url = r.url;
    if (persist) {
      const res = await fetch(r.url);
      if (!res.ok) throw new Error('The audio could not be downloaded. Try again.');
      const blob = await res.blob();
      const rec = { key: `${key}:${ci}`, docId: a.doc.id, chunkIndex: ci, cacheKey: key, blob, items: r.items, durationMs: r.durationMs, bytes: blob.size };
      await db.audio.put(rec);
      url = blobUrl(rec.key, blob);
    }
    const chunk = { url, items: r.items, durationMs: r.durationMs };
    loaded.set(ci, chunk);
    return chunk;
  })().finally(() => inflight.delete(flight));
  inflight.set(flight, p);
  return p;
}

const publish = () => player.setChunks([...loaded.values()]);

let lastPrefetch = -1;
export function installServerVoice() {
  player.beforePlay = async (index) => {
    const a = active;
    if (!a || player.getSnapshot().documentId !== a.doc.id) return;
    const s = await voiceSettings();
    if (!s.on || !s.provider || !s.voice) { if (loaded.size) { loaded.clear(); publish(); } return; }
    if (!supabase || !apiUrl) throw new Error('The earshelf server is not connected.');
    if (!hasFeature(await currentPlan(), 'natural_tts')) throw new Error('Natural voices are included with Plus.');
    const ci = chunkIndexFor(a.plan, index);
    if (ci < 0) return;
    await ensureChunk(ci);
    publish();
    if (ci + 1 < a.plan.length) void ensureChunk(ci + 1).then(publish).catch(() => {});
  };
  player.subscribe(() => {
    const st = player.getSnapshot();
    const a = active;
    if (!a || st.status !== 'playing' || st.engine !== 'audio' || st.documentId !== a.doc.id) return;
    const ci = chunkIndexFor(a.plan, st.index);
    if (ci < 0 || ci === lastPrefetch || ci + 1 >= a.plan.length) return;
    lastPrefetch = ci;
    void ensureChunk(ci + 1).then(publish).catch(() => {});
  });
}

/* ---------- offline downloads ---------- */
export async function downloadDocumentAudio(onProgress: (done: number, total: number) => void, signal?: { cancelled: boolean }) {
  const a = active;
  if (!a) throw new Error('Open the document first.');
  const s = await voiceSettings();
  if (!s.provider || !s.voice) throw new Error('Choose a natural voice first.');
  for (let ci = 0; ci < a.plan.length; ci++) {
    if (signal?.cancelled) return;
    onProgress(ci, a.plan.length);
    await ensureChunk(ci, true);
  }
  onProgress(a.plan.length, a.plan.length);
  publish();
}
export async function removeDownloads(docId: string) { await db.audio.where('docId').equals(docId).delete(); }
export async function downloadStats(docId: string) {
  const rows = await db.audio.where('docId').equals(docId).toArray();
  return { chunks: rows.length, bytes: rows.reduce((n, r) => n + r.bytes, 0) };
}

/* ---------- server info ---------- */
export function useCapabilities(signedIn: boolean): Capabilities | null {
  const [c, setC] = useState<Capabilities | null>(null);
  useEffect(() => {
    if (!signedIn || !apiUrl) { setC(null); return; }
    let live = true;
    apiGet<Capabilities>('/v1/capabilities').then((r) => live && setC(r)).catch(() => live && setC(null));
    return () => { live = false; };
  }, [signedIn]);
  return c;
}
export function useVoices(provider: string): VoiceInfo[] {
  const [v, setV] = useState<VoiceInfo[]>([]);
  useEffect(() => {
    if (!provider) { setV([]); return; }
    let live = true;
    apiGet<VoiceInfo[]>(`/v1/voices?provider=${encodeURIComponent(provider)}`).then((r) => live && setV(r)).catch(() => live && setV([]));
    return () => { live = false; };
  }, [provider]);
  return v;
}

/* ---------- audiobook export ---------- */
export interface ExportStatus { id: string; state: string; progress: number; error: string | null; result: { url: string; ext: string; bytes: number; durationMs: number; chapters: number } | null }

export async function startAudioExport(format: 'mp3' | 'm4b'): Promise<string> {
  const a = active;
  if (!a) throw new Error('Open the document first.');
  const { provider, voice } = await voiceSettings();
  if (!provider || !voice) throw new Error('Choose a natural voice first.');
  await ensureDocumentSynced(a.doc.id);
  const r = await apiPost<{ jobId: string }>('/v1/export/audio', { documentId: a.doc.id, updatedAt: a.doc.updatedAt, provider, voice, mode: a.doc.readingMode, pauseScale: a.scale, pronunciations: a.prons, format });
  return r.jobId;
}
export const exportStatus = (id: string) => apiGet<ExportStatus>(`/v1/jobs?id=${encodeURIComponent(id)}`);
