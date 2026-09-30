import { analyze, cleanPages, DEFAULT_CLEANUP, estimateMinutes, parseStructure } from '@wells/core';
import type { CleanupOptions, ParseMeta, ReadingMode } from '@wells/core';
import { db, queueSync, uid, type DocRecord } from './db';

export interface Imported {
  pages: string[];
  meta: ParseMeta;
  fileName: string;
  mime: string;
  blob?: Blob;
}

export function defaultCleanup(): CleanupOptions {
  return { ...DEFAULT_CLEANUP };
}

export function buildRecord(imp: Imported, cleanup: CleanupOptions, readingMode: ReadingMode, existingId?: string): Omit<DocRecord, 'createdAt' | 'updatedAt'> & { id: string } {
  const text = cleanPages(imp.pages, cleanup);
  const parsed = parseStructure(text, imp.meta);
  return {
    id: existingId ?? uid(),
    title: parsed.title,
    author: imp.meta.author,
    sourceType: imp.meta.sourceType,
    language: imp.meta.language,
    wordCount: parsed.wordCount,
    pageCount: imp.meta.pageCount ?? (imp.pages.length > 1 ? imp.pages.length : undefined),
    durationMin: estimateMinutes(parsed.wordCount),
    readingMode,
    cleanup,
    report: analyze(imp.pages),
    tags: [],
    parsed,
  };
}

export async function saveImport(imp: Imported, cleanup: CleanupOptions, readingMode: ReadingMode, wellId?: string): Promise<string> {
  const rec = buildRecord(imp, cleanup, readingMode);
  const now = Date.now();
  await db.transaction('rw', [db.docs, db.sources, db.wellItems, db.outbox], async () => {
    await db.docs.add({ ...rec, createdAt: now, updatedAt: now });
    await db.sources.put({ docId: rec.id, pages: imp.pages, fileName: imp.fileName, mime: imp.mime, blob: imp.blob });
    if (wellId) await db.wellItems.add({ id: uid(), wellId, docId: rec.id, position: now });
    await queueSync('documents', rec.id);
  });
  return rec.id;
}

/** Re-run cleanup with new options from the stored raw pages. */
export async function reprocess(docId: string, cleanup: CleanupOptions, readingMode: ReadingMode) {
  const [doc, src] = await Promise.all([db.docs.get(docId), db.sources.get(docId)]);
  if (!doc || !src) throw new Error('The original text for this document is missing, so it cannot be re-cleaned. Import it again.');
  const rec = buildRecord({ pages: src.pages, meta: { title: doc.title, author: doc.author, sourceType: doc.sourceType, language: doc.language, pageCount: doc.pageCount }, fileName: src.fileName, mime: src.mime }, cleanup, readingMode, docId);
  await db.docs.update(docId, { ...rec, createdAt: doc.createdAt, updatedAt: Date.now() });
  await queueSync('documents', docId);
}
