import Dexie, { type Table } from 'dexie';
import type { CleanupOptions, CleanupReport, ParsedDocument, ReadingMode, SourceType } from '@wells/core';

export interface DocRecord {
  id: string;
  title: string;
  author?: string;
  sourceType: SourceType;
  language?: string;
  wordCount: number;
  pageCount?: number;
  durationMin: number;
  readingMode: ReadingMode;
  cleanup: CleanupOptions;
  report: CleanupReport;
  tags: string[];
  parsed: ParsedDocument;
  createdAt: number;
  updatedAt: number;
  lastPlayedAt?: number;
}
export interface SourceRecord { docId: string; pages: string[]; fileName: string; mime: string; blob?: Blob }
export interface ProgressRecord { docId: string; index: number; total: number; completed: boolean; updatedAt: number }
export type SmartRule = 'in-progress' | 'finished' | 'unfinished-under-30' | 'added-this-month' | 'has-highlights' | 'not-opened-14d';
export interface WellRecord { id: string; name: string; kind: 'default' | 'custom' | 'smart'; rule?: SmartRule; voiceProfile?: string; createdAt: number }
export interface WellItemRecord { id: string; wellId: string; docId: string; position: number }
export interface AnnotationRecord {
  id: string; docId: string; kind: 'bookmark' | 'note' | 'highlight';
  blockId: string; utteranceIndex: number; text: string; body?: string;
  createdAt: number; updatedAt: number; deletedAt?: number;
}
export interface PronRecord { id: string; term: string; say: string; docId?: string }
/** Pending changes to push to Supabase once sync is wired. Local writes never wait on the network. */
export interface OutboxRecord { id?: number; table: string; recordId: string; op: 'put' | 'delete'; createdAt: number }
export interface SettingRecord { key: string; value: unknown }
/** A flashcard scheduled for spaced review. */
export interface CardRecord { id: string; docId?: string; front: string; back: string; blockId?: string; ease: number; intervalDays: number; reps: number; lapses: number; dueAt: number; createdAt: number; updatedAt: number; deletedAt?: number }
/** A generated audio chunk kept on the device for offline listening. */
export interface AudioRecord { key: string; docId: string; chunkIndex: number; cacheKey: string; blob: Blob; items: Array<{ index: number; startMs: number }>; durationMs: number; bytes: number }

class EarshelfDb extends Dexie {
  docs!: Table<DocRecord, string>;
  sources!: Table<SourceRecord, string>;
  progress!: Table<ProgressRecord, string>;
  wells!: Table<WellRecord, string>;
  wellItems!: Table<WellItemRecord, string>;
  annotations!: Table<AnnotationRecord, string>;
  pron!: Table<PronRecord, string>;
  outbox!: Table<OutboxRecord, number>;
  settings!: Table<SettingRecord, string>;
  audio!: Table<AudioRecord, string>;
  cards!: Table<CardRecord, string>;
  constructor() {
    super('earshelf');
    this.version(1).stores({
      docs: 'id, updatedAt, lastPlayedAt, createdAt',
      sources: 'docId',
      progress: 'docId, updatedAt',
      wells: 'id, kind',
      wellItems: 'id, wellId, docId',
      annotations: 'id, docId, kind, deletedAt',
      pron: 'id, docId',
      outbox: '++id, table',
      settings: 'key',
    });
    this.version(2).stores({ audio: 'key, docId' });
    this.version(3).stores({ cards: 'id, docId, dueAt' });
  }
}
export const db = new EarshelfDb();

export const uid = (): string => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

export async function queueSync(table: string, recordId: string, op: 'put' | 'delete' = 'put') {
  await db.outbox.add({ table, recordId, op, createdAt: Date.now() });
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const r = await db.settings.get(key);
  return (r ? (r.value as T) : fallback);
}
export async function setSetting(key: string, value: unknown) { await db.settings.put({ key, value }); }

export const DEFAULT_WELLS: Array<{ name: string; rule?: SmartRule }> = [
  { name: 'To listen' },
  { name: 'In progress', rule: 'in-progress' },
  { name: 'Finished', rule: 'finished' },
  { name: 'Research' }, { name: 'Work' }, { name: 'School' }, { name: 'Fiction' }, { name: 'Articles' },
  { name: 'Reference' }, { name: 'Language learning' }, { name: 'Personal development' }, { name: 'Saved for later' },
];

export async function ensureDefaultWells() {
  if (await db.wells.count()) return;
  await db.wells.bulkAdd(DEFAULT_WELLS.map((w) => ({
    id: uid(), name: w.name, kind: w.rule ? ('smart' as const) : ('default' as const), rule: w.rule, createdAt: Date.now(),
  })));
}

export const SMART_WELL_TEMPLATES: Array<{ name: string; rule: SmartRule }> = [
  { name: 'Unfinished, under 30 minutes', rule: 'unfinished-under-30' },
  { name: 'Added this month', rule: 'added-this-month' },
  { name: 'With saved highlights', rule: 'has-highlights' },
  { name: 'Not opened in 14 days', rule: 'not-opened-14d' },
];

export function matchesRule(rule: SmartRule, d: DocRecord, p: ProgressRecord | undefined, highlightedDocIds: Set<string>, now = Date.now()): boolean {
  const started = !!p && p.index > 0;
  const done = !!p?.completed;
  const DAY = 86_400_000;
  switch (rule) {
    case 'in-progress': return started && !done;
    case 'finished': return done;
    case 'unfinished-under-30': return !done && d.durationMin < 30;
    case 'added-this-month': return new Date(d.createdAt).getUTCFullYear() === new Date(now).getUTCFullYear() && new Date(d.createdAt).getUTCMonth() === new Date(now).getUTCMonth();
    case 'has-highlights': return highlightedDocIds.has(d.id);
    case 'not-opened-14d': return (d.lastPlayedAt ?? d.createdAt) < now - 14 * DAY;
  }
}

export async function deleteDocument(id: string) {
  await db.transaction('rw', [db.docs, db.sources, db.progress, db.wellItems, db.annotations, db.pron, db.outbox], async () => {
    await db.docs.delete(id);
    await db.sources.delete(id);
    await db.progress.delete(id);
    await db.wellItems.where('docId').equals(id).delete();
    await db.annotations.where('docId').equals(id).delete();
    await db.pron.where('docId').equals(id).delete();
    await queueSync('documents', id, 'delete');
  });
}

export async function deleteAllUserContent() {
  await Promise.all(db.tables.map((t) => t.clear()));
}
