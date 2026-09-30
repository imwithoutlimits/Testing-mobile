import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { BookOpen, FolderPlus, Play, Plus, Trash2, X } from 'lucide-react';
import { db, deleteDocument, uid, type DocRecord } from '../db';
import { formatDuration } from '../hooks';
import { Sheet } from '../components/Sheet';
import { DueCard } from './Review';

export function useLibrary() {
  return useLiveQuery(async () => {
    const [docs, progress] = await Promise.all([db.docs.toArray(), db.progress.toArray()]);
    const pm = new Map(progress.map((p) => [p.docId, p]));
    return docs.map((d) => ({ doc: d, progress: pm.get(d.id) })).sort((a, b) => (b.doc.lastPlayedAt ?? b.doc.createdAt) - (a.doc.lastPlayedAt ?? a.doc.createdAt));
  }, [], []);
}

export function progressFraction(d: DocRecord, p?: { index: number; total: number; completed: boolean }): number {
  if (!p) return 0;
  if (p.completed) return 1;
  return p.total > 1 ? p.index / (p.total - 1) : 0;
}

export function DocCard({ doc, progress, onOpen, onMenu }: { doc: DocRecord; progress?: { index: number; total: number; completed: boolean }; onOpen: () => void; onMenu?: () => void }) {
  const f = progressFraction(doc, progress);
  return (
    <div className="doc-card">
      <button className="doc-main" onClick={onOpen}>
        <span className="doc-type" aria-hidden>{doc.sourceType.toUpperCase().slice(0, 4)}</span>
        <span className="doc-text">
          <span className="doc-title">{doc.title}</span>
          <span className="doc-meta">{[doc.author, formatDuration(doc.durationMin * 60), progress?.completed ? 'Finished' : f > 0 ? `${Math.round(f * 100)}% listened` : null].filter(Boolean).join(' · ')}</span>
          <span className="bar" aria-hidden><span style={{ width: `${f * 100}%` }} /></span>
        </span>
      </button>
      {onMenu && <button className="icon-btn" onClick={onMenu} aria-label={`Options for ${doc.title}`}><FolderPlus size={20} /></button>}
    </div>
  );
}

export function WellPicker({ docId, onClose }: { docId: string; onClose: () => void }) {
  const wells = useLiveQuery(() => db.wells.filter((w) => w.kind !== 'smart').toArray(), [], []);
  const items = useLiveQuery(() => db.wellItems.where('docId').equals(docId).toArray(), [docId], []);
  const doc = useLiveQuery(() => db.docs.get(docId), [docId]);
  const [confirm, setConfirm] = useState(false);
  const toggle = async (wellId: string) => {
    const existing = items.find((i) => i.wellId === wellId);
    if (existing) await db.wellItems.delete(existing.id);
    else await db.wellItems.add({ id: uid(), wellId, docId, position: Date.now() });
  };
  return (
    <Sheet onClose={onClose} label="Document options">
        <header className="sheet-head"><h2>{doc?.title}</h2><button className="icon-btn" onClick={onClose} aria-label="Close"><X size={22} /></button></header>
        <h3 className="sub">Wells</h3>
        <ul className="check-list">
          {wells.map((w) => (
            <li key={w.id}><label><input type="checkbox" checked={items.some((i) => i.wellId === w.id)} onChange={() => void toggle(w.id)} /> {w.name}</label></li>
          ))}
        </ul>
        {!confirm ? (
          <button className="btn danger" onClick={() => setConfirm(true)}><Trash2 size={16} /> Delete document</button>
        ) : (
          <div className="error-box"><p>Delete this document, its notes, highlights and progress from this device?</p>
            <div className="row-end"><button className="btn" onClick={() => setConfirm(false)}>Keep it</button><button className="btn danger" onClick={() => void deleteDocument(docId).then(onClose)}>Delete</button></div></div>
        )}
    </Sheet>
  );
}

export function Home({ onOpen, onImport, onReview }: { onOpen: (docId: string) => void; onImport: () => void; onReview: () => void }) {
  const lib = useLibrary();
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const resume = lib.find((l) => l.progress && !l.progress.completed && l.progress.index > 0);
  return (
    <section className="page">
      <header className="page-head"><h1>Home</h1><button className="btn primary" onClick={onImport}><Plus size={18} /> Add</button></header>

      {lib.length === 0 ? (
        <div className="empty">
          <BookOpen size={36} aria-hidden />
          <h2>Your library is empty</h2>
          <p>Add a PDF, EPUB, Word file or article. earshelf cleans it up and reads it to you, and your library stays on this device so it works offline.</p>
          <button className="btn primary" onClick={onImport}><Plus size={18} /> Add your first document</button>
        </div>
      ) : (
        <>
          <DueCard onReview={onReview} />
          {resume && (
            <button className="resume-card" onClick={() => onOpen(resume.doc.id)}>
              <span className="resume-play"><Play size={22} /></span>
              <span className="resume-text">
                <span className="resume-label">Continue listening</span>
                <span className="resume-title">{resume.doc.title}</span>
                <span className="doc-meta">{Math.round(progressFraction(resume.doc, resume.progress) * 100)}% listened · {formatDuration(resume.doc.durationMin * 60 * (1 - progressFraction(resume.doc, resume.progress)))} left</span>
              </span>
            </button>
          )}
          <h2 className="sub">Library</h2>
          <div className="doc-list">
            {lib.map(({ doc, progress }) => <DocCard key={doc.id} doc={doc} progress={progress} onOpen={() => onOpen(doc.id)} onMenu={() => setMenuFor(doc.id)} />)}
          </div>
        </>
      )}
      {menuFor && <WellPicker docId={menuFor} onClose={() => setMenuFor(null)} />}
    </section>
  );
}
