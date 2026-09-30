import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Search as SearchIcon } from 'lucide-react';
import { searchDocument } from '@wells/core';
import { hasFeature } from '@wells/billing/src/plans.ts';
import { db } from '../db';
import { useUser } from '../auth';
import { usePlan } from '../hooks';
import { useCapabilities } from '../serverVoice';
import { searchMeaning, type MeaningHit } from '../semantic';
import { ApiError } from '../supabase';

export function Search({ onOpen }: { onOpen: (docId: string, blockId?: string) => void }) {
  const user = useUser();
  const plan = usePlan();
  const caps = useCapabilities(!!user);
  const docs = useLiveQuery(() => db.docs.toArray(), [], []);
  const [q, setQ] = useState('');
  const [byMeaning, setByMeaning] = useState(false);
  const [hits, setHits] = useState<MeaningHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canMeaning = !!user && !!caps?.embeddings && hasFeature(plan, 'semantic_search');

  const results = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (t.length < 2) return [];
    return docs.map((d) => {
      const titleHit = `${d.title} ${d.author ?? ''}`.toLowerCase().includes(t);
      return { doc: d, titleHit, hits: searchDocument(d.parsed, q, 3) };
    }).filter((r) => r.titleHit || r.hits.length).sort((a, b) => Number(b.titleHit) - Number(a.titleHit) || b.hits.length - a.hits.length);
  }, [docs, q]);

  useEffect(() => {
    if (!byMeaning || q.trim().length < 3) { setHits(null); setError(null); return; }
    let live = true;
    const t = setTimeout(async () => {
      setBusy(true); setError(null);
      try { const r = await searchMeaning(q.trim()); if (live) setHits(r); }
      catch (e) {
        if (!live) return;
        setHits(null);
        setError(e instanceof ApiError && e.code === 'upgrade_required' ? 'Searching your whole library by meaning is included with Pro. You can still search by meaning inside a single document from the reader.' : e instanceof Error ? e.message : 'Search failed. Try again.');
      } finally { if (live) setBusy(false); }
    }, 450);
    return () => { live = false; clearTimeout(t); };
  }, [q, byMeaning]);

  const titles = new Map(docs.map((d) => [d.id, d.title]));
  const grouped = useMemo(() => {
    const m = new Map<string, MeaningHit[]>();
    (hits ?? []).forEach((h) => m.set(h.documentId, [...(m.get(h.documentId) ?? []), h]));
    return [...m.entries()];
  }, [hits]);

  return (
    <section className="page">
      <header className="page-head"><h1>Search</h1></header>
      <div className="search-box">
        <SearchIcon size={20} aria-hidden />
        <input className="text-input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={byMeaning ? 'Describe what you are looking for' : 'Search titles and text across your library'} aria-label="Search your library" />
      </div>
      {canMeaning && <label className="check-row"><input type="checkbox" checked={byMeaning} onChange={(e) => setByMeaning(e.target.checked)} /> Search by meaning</label>}

      {q.trim().length < 2 ? (
        <div className="empty"><p>{byMeaning ? 'Describe an idea and earshelf finds the passages about it, even when the words differ.' : 'Search finds exact words and phrases in every document on this device.'}</p></div>
      ) : byMeaning ? (
        <>
          {busy && <p className="hint" role="status">Searching…</p>}
          {error && <p role="alert" className="error-text">{error}</p>}
          {!busy && !error && hits && grouped.length === 0 && <div className="empty"><p>Nothing close to “{q.trim()}”. Try describing it differently, or wait a moment if you just added documents, since new ones are prepared in the background.</p></div>}
          <ul className="results grouped">
            {grouped.map(([docId, hs]) => (
              <li key={docId}>
                <button className="link-btn strong" onClick={() => onOpen(docId)}>{titles.get(docId) ?? 'Document'}</button>
                {hs.map((h) => <button key={h.blockId + h.snippet.slice(0, 12)} className="link-btn snippet" onClick={() => onOpen(docId, h.blockId)}><strong>{h.sectionTitle}.</strong> {h.snippet}…</button>)}
              </li>
            ))}
          </ul>
        </>
      ) : results.length === 0 ? (
        <div className="empty"><p>No matches for “{q.trim()}”. Try fewer or different words.</p></div>
      ) : (
        <ul className="results grouped">
          {results.map(({ doc, hits: hs }) => (
            <li key={doc.id}>
              <button className="link-btn strong" onClick={() => onOpen(doc.id)}>{doc.title}</button>
              {hs.map((h) => <button key={h.blockId} className="link-btn snippet" onClick={() => onOpen(doc.id, h.blockId)}>{h.snippet}</button>)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
