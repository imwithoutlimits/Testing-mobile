import { useEffect } from 'react';
import { ApiError, apiPost } from './supabase';
import { db, getSetting, setSetting } from './db';
import { ensureDocumentSynced } from './sync';
import { reportError } from './monitor';

export interface MeaningHit { documentId: string; blockId: string; sectionTitle: string; snippet: string; score: number }

export async function searchMeaning(query: string, documentId?: string): Promise<MeaningHit[]> {
  return (await apiPost<{ hits: MeaningHit[] }>('/v1/search', { query, documentId })).hits;
}

let running = false;
let pausedUntil = 0;

/** Sends any document that changed since it was last indexed. Runs quietly in the background. */
export async function indexPending(): Promise<void> {
  if (running || Date.now() < pausedUntil) return;
  running = true;
  try {
    // Reads index keys only, so it stays cheap even with large documents.
    const ids = (await db.docs.orderBy('updatedAt').primaryKeys()) as string[];
    const versions = (await db.docs.orderBy('updatedAt').keys()) as number[];
    for (let i = 0; i < ids.length; i++) {
      const key = `indexed:${ids[i]}`;
      if ((await getSetting<number>(key, 0)) === versions[i]) continue;
      await ensureDocumentSynced(ids[i]);
      await apiPost('/v1/index', { documentId: ids[i], updatedAt: versions[i] });
      await setSetting(key, versions[i]);
    }
  } catch (e) {
    pausedUntil = Date.now() + 10 * 60_000; // a plan limit or server hiccup: try again later, not every few seconds
    if (!(e instanceof ApiError) || e.status >= 500) reportError(e, 'index');
  } finally { running = false; }
}

export function useAutoIndex(enabled: boolean, trigger: unknown) {
  useEffect(() => { if (enabled) void indexPending(); }, [enabled, trigger]);
}
