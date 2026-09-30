import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft, Plus, Trash2, Sparkles } from 'lucide-react';
import { db, matchesRule, SMART_WELL_TEMPLATES, uid, type WellRecord } from '../db';
import { DocCard, useLibrary } from './Home';
import { VOICE_PROFILES } from '../hooks';

export function Wells({ onOpen }: { onOpen: (docId: string) => void }) {
  const wells = useLiveQuery(() => db.wells.toArray(), [], []);
  const items = useLiveQuery(() => db.wellItems.toArray(), [], []);
  const highlights = useLiveQuery(() => db.annotations.where('kind').equals('highlight').filter((a) => !a.deletedAt).toArray(), [], []);
  const lib = useLibrary();
  const [openId, setOpenId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [smart, setSmart] = useState('');

  const hlDocs = new Set(highlights.map((h) => h.docId));
  const docsIn = (w: WellRecord) => {
    if (w.kind === 'smart' && w.rule) return lib.filter((l) => matchesRule(w.rule!, l.doc, l.progress, hlDocs));
    const ids = new Set(items.filter((i) => i.wellId === w.id).map((i) => i.docId));
    return lib.filter((l) => ids.has(l.doc.id));
  };

  const open = wells.find((w) => w.id === openId);
  if (open) {
    const docs = docsIn(open);
    return (
      <section className="page">
        <header className="page-head">
          <button className="icon-btn" onClick={() => setOpenId(null)} aria-label="Back to wells"><ArrowLeft size={22} /></button>
          <h1>{open.name}</h1>
          {open.kind !== 'default' && <button className="icon-btn" aria-label={`Delete ${open.name}`} onClick={() => void db.transaction('rw', db.wells, db.wellItems, async () => { await db.wellItems.where('wellId').equals(open.id).delete(); await db.wells.delete(open.id); }).then(() => setOpenId(null))}><Trash2 size={20} /></button>}
        </header>
        {open.kind !== 'smart' && (
          <label className="field">Voice style for this well
            <select value={open.voiceProfile ?? ''} onChange={(e) => void db.wells.update(open.id, { voiceProfile: e.target.value || undefined })}>
              <option value="">Use my default</option>
              {VOICE_PROFILES.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.blurb}</option>)}
            </select>
            <span className="hint">Documents you open from this well use this pace and these pauses.</span>
          </label>
        )}
        {docs.length === 0 ? (
          <div className="empty"><p>{open.kind === 'smart' ? 'Nothing matches this well right now.' : 'This well is empty. Add documents from your library using the folder button on each one.'}</p></div>
        ) : (
          <div className="doc-list">{docs.map(({ doc, progress }) => <DocCard key={doc.id} doc={doc} progress={progress} onOpen={() => onOpen(doc.id)} />)}</div>
        )}
      </section>
    );
  }

  return (
    <section className="page">
      <header className="page-head"><h1>Wells</h1></header>
      <form className="inline-form" onSubmit={(e) => { e.preventDefault(); if (!name.trim()) return; void db.wells.add({ id: uid(), name: name.trim(), kind: 'custom', createdAt: Date.now() }); setName(''); }}>
        <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="New well name" aria-label="New well name" />
        <button className="btn primary" type="submit" disabled={!name.trim()}><Plus size={18} /> Create</button>
      </form>
      <div className="inline-form">
        <select value={smart} onChange={(e) => setSmart(e.target.value)} aria-label="Smart well template">
          <option value="">Add a smart well…</option>
          {SMART_WELL_TEMPLATES.filter((t) => !wells.some((w) => w.rule === t.rule)).map((t) => <option key={t.rule} value={t.rule}>{t.name}</option>)}
        </select>
        <button className="btn" disabled={!smart} onClick={() => { const t = SMART_WELL_TEMPLATES.find((x) => x.rule === smart); if (t) void db.wells.add({ id: uid(), name: t.name, kind: 'smart', rule: t.rule, createdAt: Date.now() }); setSmart(''); }}><Sparkles size={18} /> Add</button>
      </div>
      <ul className="well-list">
        {wells.map((w) => (
          <li key={w.id}>
            <button className="well-row" onClick={() => setOpenId(w.id)}>
              <span className="well-name">{w.name}</span>
              <span className="well-kind">{w.kind === 'smart' ? 'Smart' : w.kind === 'custom' ? 'Yours' : ''}</span>
              <span className="count">{docsIn(w).length}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
