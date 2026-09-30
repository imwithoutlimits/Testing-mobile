import { useSyncExternalStore } from 'react';
import type { Session } from '@supabase/supabase-js';
import { db, deleteAllUserContent, getSetting, setSetting, type AnnotationRecord, type DocRecord } from './db';
import { reportError } from './monitor';
import { supabase } from './supabase';
import type { Plan } from '@wells/billing/src/plans.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const PRODUCT = 'earshelf';
export const SYNCED_SETTINGS = ['theme', 'voiceProfile', 'rate', 'pauseScale', 'defaultMode', 'voiceURI', 'useServerVoice', 'ttsProvider', 'ttsVoice'];
const iso = (ms: number | undefined) => (ms ? new Date(ms).toISOString() : null);
const ms = (s: string | null | undefined) => (s ? Date.parse(s) : undefined);

/* ---------- status ---------- */
export interface SyncStatus { state: 'off' | 'idle' | 'syncing' | 'offline' | 'error'; lastSyncedAt?: number; error?: string }
let status: SyncStatus = { state: 'off' };
const listeners = new Set<() => void>();
const setStatus = (s: SyncStatus) => { status = s; listeners.forEach((l) => l()); };
export const useSyncStatus = () => useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => status);

/* ---------- capture local changes automatically ---------- */
let suppress = false; // true while applying data that came from the server
const canon = (t: string) => (t === 'bookmarks' || t === 'highlights' || t === 'notes' ? 'annotations' : t);
function enqueue(table: string, recordId: string, op: 'put' | 'delete' = 'put') {
  if (suppress || !recordId) return;
  void db.outbox.add({ table: canon(table), recordId, op, createdAt: Date.now() });
}
function watch<T>(table: import('dexie').Table<T, string>, remote: string, key: (o: T) => string, only?: (o: T) => boolean) {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  table.hook('creating', function (this: any, _pk: any, obj: T) { if (suppress || (only && !only(obj))) return; this.onsuccess = () => enqueue(remote, key(obj)); });
  table.hook('updating', function (this: any, _mods: any, _pk: any, obj: T) { if (suppress || (only && !only(obj))) return; this.onsuccess = () => enqueue(remote, key(obj)); });
  table.hook('deleting', function (this: any, _pk: any, obj: T) { if (suppress || (only && !only(obj))) return; this.onsuccess = () => enqueue(remote, key(obj), 'delete'); });
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
watch(db.docs, 'documents', (o) => o.id);
watch(db.progress, 'playback_progress', (o) => o.docId);
watch(db.wells, 'wells', (o) => o.id);
watch(db.wellItems, 'well_items', (o) => o.id);
watch(db.annotations, 'annotations', (o) => o.id);
watch(db.pron, 'document_pronunciations', (o) => o.id);
watch(db.cards, 'review_cards', (o) => o.id);
watch(db.settings, 'user_preferences', () => 'prefs', (o) => SYNCED_SETTINGS.includes(o.key));

/* ---------- push ---------- */
let uid: string | null = null;
const pushedContent = new Map<string, number>();

async function pushDocument(id: string, deleted: boolean) {
  if (!supabase || !uid) return;
  const doc = deleted ? undefined : await db.docs.get(id);
  if (!doc) { await supabase.from('documents').update({ deleted_at: new Date().toISOString() }).eq('id', id).eq('user_id', uid); return; }
  const path = `${uid}/${id}/content.json`;
  if (pushedContent.get(id) !== doc.updatedAt) {
    const src = await db.sources.get(id);
    const body = new Blob([JSON.stringify({ parsed: doc.parsed, pages: src?.pages ?? [], cleanup: doc.cleanup, report: doc.report })], { type: 'application/json' });
    const up = await supabase.storage.from('originals').upload(path, body, { upsert: true, contentType: 'application/json' });
    if (up.error) throw up.error;
    pushedContent.set(id, doc.updatedAt);
    if (src?.blob && src.blob.size <= 50 * 1024 * 1024 && !(await getSetting(`sync:orig:${id}`, false))) {
      const safe = src.fileName.replace(/[^\w.\- ]+/g, '_');
      const o = await supabase.storage.from('originals').upload(`${uid}/${id}/original/${safe}`, src.blob, { upsert: true, contentType: src.mime || 'application/octet-stream' });
      if (!o.error) await setSetting(`sync:orig:${id}`, true);
    }
  }
  const { data, error } = await supabase.from('documents').upsert({
    id, user_id: uid, title: doc.title, author: doc.author ?? null, source_type: doc.sourceType, language: doc.language ?? null,
    word_count: doc.wordCount, page_count: doc.pageCount ?? null, duration_min: doc.durationMin, status: 'ready', reading_mode: doc.readingMode,
    tags: doc.tags, last_played_at: iso(doc.lastPlayedAt), content_path: path, cleanup: doc.cleanup, report: doc.report, deleted_at: null,
    created_at: iso(doc.createdAt), source_name: (await db.sources.get(id))?.fileName ?? null,
  }).select('updated_at').single();
  if (error) throw error;
  await setSetting(`sync:doc:${id}`, data.updated_at);
}

export async function ensureDocumentSynced(id: string) {
  if (!supabase || !uid) return;
  const doc = await db.docs.get(id);
  if (doc && pushedContent.get(id) !== doc.updatedAt) await pushDocument(id, false);
}

const annTable = (k: AnnotationRecord['kind']) => (k === 'bookmark' ? 'bookmarks' : k === 'highlight' ? 'highlights' : 'notes');

async function pushBatch(table: string, items: Array<{ recordId: string; op: 'put' | 'delete' }>) {
  if (!supabase || !uid) return;
  const ids = items.map((i) => i.recordId);
  const del = new Set(items.filter((i) => i.op === 'delete').map((i) => i.recordId));
  const now = new Date().toISOString();
  const must = (r: { error: unknown }) => { if (r.error) throw r.error; };

  if (table === 'documents') { for (const it of items) await pushDocument(it.recordId, it.op === 'delete'); return; }

  if (table === 'wells') {
    const rows = (await db.wells.bulkGet(ids)).map((w, i) => (w && !del.has(ids[i]) ? { id: w.id, user_id: uid, product: PRODUCT, name: w.name, kind: w.kind, smart_rule: w.rule ? { rule: w.rule } : null, voice_id: w.voiceProfile ?? null, created_at: iso(w.createdAt), deleted_at: null } : { id: ids[i], user_id: uid, product: PRODUCT, name: '(deleted)', deleted_at: now }));
    must(await supabase.from('wells').upsert(rows));
  } else if (table === 'well_items') {
    for (let i = 0; i < ids.length; i++) {
      const w = del.has(ids[i]) ? undefined : await db.wellItems.get(ids[i]);
      const r = w ? await supabase.from('well_items').upsert({ id: w.id, well_id: w.wellId, user_id: uid, item_type: 'document', item_id: w.docId, position: w.position, deleted_at: null })
        : await supabase.from('well_items').update({ deleted_at: now }).eq('id', ids[i]).eq('user_id', uid);
      if (r.error) { if ((r.error as { code?: string }).code === '23505') { await db.wellItems.delete(ids[i]).catch(() => {}); continue; } throw r.error; }
    }
  } else if (table === 'playback_progress') {
    const rows = (await db.progress.bulkGet(ids)).filter((p): p is NonNullable<typeof p> => !!p).map((p) => ({ user_id: uid, product: PRODUCT, item_type: 'document', item_id: p.docId, utterance_index: p.index, total: p.total, completed: p.completed, device_id: deviceId() }));
    if (rows.length) must(await supabase.from('playback_progress').upsert(rows, { onConflict: 'user_id,product,item_type,item_id' }));
  } else if (table === 'annotations') {
    const anns = await db.annotations.bulkGet(ids);
    for (const kind of ['bookmark', 'highlight', 'note'] as const) {
      const rows = anns.filter((a): a is AnnotationRecord => !!a && a.kind === kind).map((a) => {
        const base = { id: a.id, user_id: uid, product: PRODUCT, item_type: 'document', item_id: a.docId, locator: { blockId: a.blockId, utteranceIndex: a.utteranceIndex, text: a.text }, deleted_at: iso(a.deletedAt), created_at: iso(a.createdAt) };
        return kind === 'bookmark' ? { ...base, label: a.text } : kind === 'highlight' ? { ...base, text: a.text } : { ...base, body: a.body ?? '', is_private: true };
      });
      if (rows.length) must(await supabase.from(annTable(kind)).upsert(rows));
    }
  } else if (table === 'review_cards') {
    const rows = (await db.cards.bulkGet(ids)).filter((c): c is NonNullable<typeof c> => !!c).map((c) => ({
      id: c.id, user_id: uid, document_id: c.docId ?? null, front: c.front, back: c.back, block_ref: c.blockId ?? null, ease: c.ease, interval_days: c.intervalDays,
      reps: c.reps, lapses: c.lapses, due_at: iso(c.dueAt), created_at: iso(c.createdAt), deleted_at: iso(c.deletedAt),
    }));
    if (rows.length) must(await supabase.from('review_cards').upsert(rows));
  } else if (table === 'document_pronunciations') {
    const rows = (await db.pron.bulkGet(ids)).map((p, i) => (p && !del.has(ids[i]) ? { id: p.id, user_id: uid, document_id: p.docId ?? null, term: p.term, say: p.say, deleted_at: null } : { id: ids[i], user_id: uid, term: '(deleted)', say: '', deleted_at: now }));
    must(await supabase.from('document_pronunciations').upsert(rows));
  } else if (table === 'user_preferences') {
    const prefs: Row = {};
    for (const k of SYNCED_SETTINGS) { const r = await db.settings.get(k); if (r) prefs[k] = r.value; }
    must(await supabase.from('user_preferences').upsert({ user_id: uid, product: PRODUCT, prefs }, { onConflict: 'user_id,product' }));
  }
}

let pushing = false;
export async function push() {
  if (!supabase || !uid || pushing) return;
  pushing = true;
  try {
    const all = await db.outbox.toArray();
    const latest = new Map<string, { table: string; recordId: string; op: 'put' | 'delete'; ids: number[] }>();
    for (const o of all) {
      const k = `${o.table}:${o.recordId}`;
      const e = latest.get(k) ?? { table: o.table, recordId: o.recordId, op: o.op, ids: [] };
      e.op = o.op; e.ids.push(o.id!); latest.set(k, e);
    }
    const order = ['documents', 'wells', 'well_items', 'playback_progress', 'annotations', 'review_cards', 'document_pronunciations', 'user_preferences'];
    for (const table of order) {
      const items = [...latest.values()].filter((e) => e.table === table);
      if (!items.length) continue;
      await pushBatch(table, items);
      await db.outbox.bulkDelete(items.flatMap((i) => i.ids)); // only after the server accepted them
    }
  } finally { pushing = false; }
}

/* ---------- pull ---------- */
const DEVICE_KEY = 'earshelf-device';
function deviceId(): string {
  let d = localStorage.getItem(DEVICE_KEY);
  if (!d) { d = crypto.randomUUID(); localStorage.setItem(DEVICE_KEY, d); }
  return d;
}

async function pullTable(name: string, apply: (rows: Row[], pending: Set<string>) => Promise<void>) {
  if (!supabase || !uid) return;
  const cursorKey = `cursor:${name}`;
  let cursor = await getSetting<string>(cursorKey, '1970-01-01T00:00:00Z');
  for (;;) {
    const { data, error } = await supabase.from(name).select('*').eq('user_id', uid).gt('updated_at', cursor).order('updated_at', { ascending: true }).limit(500);
    if (error) throw error;
    if (!data.length) return;
    const pending = new Set((await db.outbox.toArray()).map((o) => `${o.table}:${o.recordId}`));
    suppress = true;
    try { await apply(data as Row[], pending); } finally { suppress = false; }
    cursor = data[data.length - 1].updated_at as string;
    await setSetting(cursorKey, cursor);
    if (data.length < 500) return;
  }
}

async function applyDocuments(rows: Row[], pending: Set<string>) {
  if (!supabase) return;
  for (const r of rows) {
    if (pending.has(`documents:${r.id}`)) continue;
    if (r.deleted_at) {
      await db.transaction('rw', [db.docs, db.sources, db.progress, db.wellItems, db.annotations, db.pron], async () => {
        await db.docs.delete(r.id); await db.sources.delete(r.id); await db.progress.delete(r.id);
        await db.wellItems.where('docId').equals(r.id).delete(); await db.annotations.where('docId').equals(r.id).delete(); await db.pron.where('docId').equals(r.id).delete();
      });
      continue;
    }
    if ((await db.docs.get(r.id)) && (await getSetting(`sync:doc:${r.id}`, '')) === r.updated_at) continue; // our own push coming back
    const dl = await supabase.storage.from('originals').download(r.content_path as string);
    if (dl.error || !dl.data) continue; // content not uploaded yet; the next pull retries because the cursor only moves past rows we applied
    const c = JSON.parse(await dl.data.text()) as { parsed: DocRecord['parsed']; pages: string[]; cleanup: DocRecord['cleanup']; report: DocRecord['report'] };
    const doc: DocRecord = {
      id: r.id, title: r.title, author: r.author ?? undefined, sourceType: r.source_type, language: r.language ?? undefined, wordCount: r.word_count ?? c.parsed.wordCount,
      pageCount: r.page_count ?? undefined, durationMin: r.duration_min ?? 1, readingMode: r.reading_mode, cleanup: c.cleanup, report: c.report, tags: r.tags ?? [], parsed: c.parsed,
      createdAt: ms(r.created_at) ?? Date.now(), updatedAt: ms(r.updated_at) ?? Date.now(), lastPlayedAt: ms(r.last_played_at),
    };
    await db.docs.put(doc);
    if (!(await db.sources.get(r.id))) await db.sources.put({ docId: r.id, pages: c.pages, fileName: r.source_name ?? `${r.title}.txt`, mime: 'text/plain' });
    pushedContent.set(r.id, doc.updatedAt);
    await setSetting(`sync:doc:${r.id}`, r.updated_at);
  }
}

export async function pull() {
  if (!supabase || !uid) return;
  await pullTable('documents', applyDocuments);
  await pullTable('wells', async (rows, pending) => {
    for (const r of rows) {
      if (pending.has(`wells:${r.id}`)) continue;
      if (r.deleted_at) { await db.wells.delete(r.id); await db.wellItems.where('wellId').equals(r.id).delete(); }
      else await db.wells.put({ id: r.id, name: r.name, kind: r.kind, rule: r.smart_rule?.rule, voiceProfile: r.voice_id ?? undefined, createdAt: ms(r.created_at) ?? Date.now() });
    }
  });
  await pullTable('well_items', async (rows, pending) => {
    for (const r of rows) {
      if (pending.has(`well_items:${r.id}`)) continue;
      if (r.deleted_at) await db.wellItems.delete(r.id);
      else await db.wellItems.put({ id: r.id, wellId: r.well_id, docId: r.item_id, position: Number(r.position) });
    }
  });
  await pullTable('playback_progress', async (rows, pending) => {
    for (const r of rows) {
      if (pending.has(`playback_progress:${r.item_id}`)) continue;
      const local = await db.progress.get(r.item_id);
      const remoteAt = ms(r.updated_at) ?? 0;
      if (!local || local.updatedAt < remoteAt) await db.progress.put({ docId: r.item_id, index: r.utterance_index, total: r.total, completed: r.completed, updatedAt: remoteAt });
    }
  });
  for (const [remote, kind] of [['bookmarks', 'bookmark'], ['highlights', 'highlight'], ['notes', 'note']] as const) {
    await pullTable(remote, async (rows, pending) => {
      for (const r of rows) {
        if (pending.has(`annotations:${r.id}`)) continue;
        await db.annotations.put({
          id: r.id, docId: r.item_id, kind, blockId: r.locator?.blockId ?? '', utteranceIndex: r.locator?.utteranceIndex ?? 0, text: r.locator?.text ?? r.text ?? r.label ?? '',
          body: kind === 'note' ? r.body : undefined, createdAt: ms(r.created_at) ?? Date.now(), updatedAt: ms(r.updated_at) ?? Date.now(), deletedAt: ms(r.deleted_at),
        });
      }
    });
  }
  await pullTable('review_cards', async (rows, pending) => {
    for (const r of rows) {
      if (pending.has(`review_cards:${r.id}`)) continue;
      await db.cards.put({ id: r.id, docId: r.document_id ?? undefined, front: r.front, back: r.back, blockId: r.block_ref ?? undefined, ease: r.ease, intervalDays: r.interval_days, reps: r.reps, lapses: r.lapses, dueAt: ms(r.due_at) ?? Date.now(), createdAt: ms(r.created_at) ?? Date.now(), updatedAt: ms(r.updated_at) ?? Date.now(), deletedAt: ms(r.deleted_at) });
    }
  });
  await pullTable('document_pronunciations', async (rows, pending) => {
    for (const r of rows) {
      if (pending.has(`document_pronunciations:${r.id}`)) continue;
      if (r.deleted_at) await db.pron.delete(r.id); else await db.pron.put({ id: r.id, term: r.term, say: r.say, docId: r.document_id ?? undefined });
    }
  });
  await pullTable('user_preferences', async (rows, pending) => {
    if (pending.has('user_preferences:prefs')) return;
    for (const r of rows) if (r.product === PRODUCT) for (const k of SYNCED_SETTINGS) if (k in (r.prefs ?? {})) await db.settings.put({ key: k, value: r.prefs[k] });
  });
  // Plan comes from verified entitlements written by the billing webhook.
  const ent = await supabase.from('entitlements').select('plan,active,expires_at').eq('user_id', uid).eq('product', PRODUCT).maybeSingle();
  if (!ent.error) {
    const e = ent.data as { plan: Plan; active: boolean; expires_at: string | null } | null;
    const valid = !!e && e.active && (!e.expires_at || Date.parse(e.expires_at) > Date.now());
    await db.settings.put({ key: 'plan', value: valid ? e!.plan : 'free' });
  }
}

/* ---------- loop ---------- */
let timer: ReturnType<typeof setInterval> | null = null;
let tick = 0;

export async function syncNow(fullPull = true) {
  if (!supabase || !uid) return;
  if (!navigator.onLine) { setStatus({ ...status, state: 'offline' }); return; }
  setStatus({ ...status, state: 'syncing' });
  try {
    await push();
    if (fullPull) await pull();
    setStatus({ state: 'idle', lastSyncedAt: Date.now() });
  } catch (e) {
    const m = e instanceof Error ? e.message : (e as { message?: string })?.message ?? 'Sync failed';
    setStatus({ state: 'error', lastSyncedAt: status.lastSyncedAt, error: m });
    reportError(e instanceof Error ? e : new Error(m), 'sync');
  }
}

async function enqueueEverything() {
  const add = (table: string, ids: string[]) => db.outbox.bulkAdd(ids.map((recordId) => ({ table, recordId, op: 'put' as const, createdAt: Date.now() })));
  await add('documents', (await db.docs.toCollection().primaryKeys()) as string[]);
  await add('wells', (await db.wells.toCollection().primaryKeys()) as string[]);
  await add('well_items', (await db.wellItems.toCollection().primaryKeys()) as string[]);
  await add('playback_progress', (await db.progress.toCollection().primaryKeys()) as string[]);
  await add('annotations', (await db.annotations.toCollection().primaryKeys()) as string[]);
  await add('review_cards', (await db.cards.toCollection().primaryKeys()) as string[]);
  await add('document_pronunciations', (await db.pron.toCollection().primaryKeys()) as string[]);
  await add('user_preferences', ['prefs']);
}

export async function startSync(session: Session) {
  if (!supabase) return;
  const prev = await getSetting<string | null>('sync:user', null);
  if (prev && prev !== session.user.id) await deleteAllUserContent(); // never mix two people's libraries on one device
  uid = session.user.id;
  if (prev !== uid) { await setSetting('sync:user', uid); await enqueueEverything(); }
  await syncNow(true);
  if (timer) clearInterval(timer);
  timer = setInterval(() => { if (document.visibilityState === 'visible') void syncNow(++tick % 6 === 0); }, 5000);
  window.addEventListener('online', onWake);
  document.addEventListener('visibilitychange', onWake);
}
function onWake() { if (document.visibilityState === 'visible' && navigator.onLine) void syncNow(true); }

export function stopSync() {
  if (timer) clearInterval(timer);
  timer = null; uid = null;
  window.removeEventListener('online', onWake);
  document.removeEventListener('visibilitychange', onWake);
  setStatus({ state: 'off' });
}

/** Returns how many changes have not reached the server yet. */
export async function pendingChanges(): Promise<number> { return db.outbox.count(); }
