import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft, Bookmark, Highlighter, List, Pause, Play, Search, SlidersHorizontal, Sparkles, StickyNote, Volume2, X } from 'lucide-react';
import { searchDocument } from '@wells/core';
import type { ReadingMode, Utterance, CleanupOptions } from '@wells/core';
import { db, queueSync, uid } from '../db';
import { MODE_LABELS, loadIntoPlayer, player, useDocStyle, useHasFeature, usePlayer, useUtterances } from '../hooks';
import { useUser } from '../auth';
import { ApiError, apiPost } from '../supabase';
import { ensureDocumentSynced } from '../sync';
import { searchMeaning, type MeaningHit } from '../semantic';
import { useCapabilities } from '../serverVoice';
import { reprocess } from '../pipeline';
import { CleanupPanel } from '../components/CleanupPanel';
import { AiPanel } from '../components/AiPanel';
import { registerDocument } from '../serverVoice';

interface Explanation { kind: 'table' | 'figure'; explanation: string; keyPoints: string[]; note?: string }
const isFigure = (b: { type: string; text: string }) => b.type === 'caption' && /^(figure|fig\.)\s+\d+/i.test(b.text);

type Panel = null | 'contents' | 'search' | 'settings' | 'ai';

export function Reader({ docId, focusBlockId, onBack }: { docId: string; focusBlockId?: string; onBack: () => void }) {
  const doc = useLiveQuery(() => db.docs.get(docId), [docId]);
  const utterances = useUtterances(doc);
  const style = useDocStyle(docId);
  const annotations = useLiveQuery(() => db.annotations.where('docId').equals(docId).filter((a) => !a.deletedAt).toArray(), [docId], []);
  const ps = usePlayer();
  const [panel, setPanel] = useState<Panel>(null);
  const [follow, setFollow] = useState(true);
  const [selected, setSelected] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [cleanup, setCleanup] = useState<CleanupOptions | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const focused = useRef(false);
  const user = useUser();
  const caps = useCapabilities(!!user);
  const canExplain = useHasFeature('table_figure_explain');
  const canMeaning = useHasFeature('semantic_search') && !!caps?.embeddings;
  const [explains, setExplains] = useState<Record<string, { loading?: boolean; error?: string; data?: Explanation }>>({});
  const [byMeaning, setByMeaning] = useState(false);
  const [meaningHits, setMeaningHits] = useState<MeaningHit[]>([]);
  const [meaningBusy, setMeaningBusy] = useState(false);
  const [meaningError, setMeaningError] = useState<string | null>(null);

  useEffect(() => { if (doc && utterances.length) void loadIntoPlayer(doc, utterances); }, [doc, utterances]);
  // Tell the natural-voice layer what is loaded. Keyed on updatedAt, not the whole record, because progress writes touch the record every second.
  useEffect(() => { if (doc && utterances.length) void registerDocument(doc, utterances, style.pause); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.id, doc?.updatedAt, utterances, style.pause]);
  // A well's voice style sets the pace for documents opened from it.
  useEffect(() => { player.setRate(style.rate); }, [style.rate, docId]);
  useEffect(() => { focused.current = false; }, [docId, focusBlockId]);

  const mine = ps.documentId === docId;
  const playing = mine && ps.status === 'playing';

  const byBlock = useMemo(() => {
    const m = new Map<string, Array<{ u: Utterance; i: number }>>();
    utterances.forEach((u, i) => { const a = m.get(u.blockId) ?? []; a.push({ u, i }); m.set(u.blockId, a); });
    return m;
  }, [utterances]);

  // Jump to a block requested from search or activity.
  useEffect(() => {
    if (!focusBlockId || focused.current || !mine) return;
    const first = byBlock.get(focusBlockId)?.[0]?.i;
    if (first === undefined) return;
    focused.current = true;
    player.seekTo(first);
    document.querySelector(`[data-b="${focusBlockId}"]`)?.scrollIntoView({ block: 'center' });
  }, [focusBlockId, byBlock, mine]);

  // Follow playback.
  useEffect(() => {
    if (!follow || !playing) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.querySelector(`[data-u="${ps.index}"]`)?.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  }, [ps.index, follow, playing]);

  useEffect(() => {
    if (!byMeaning || query.trim().length < 3) { setMeaningHits([]); setMeaningError(null); return; }
    let live = true;
    const t = setTimeout(async () => {
      setMeaningBusy(true); setMeaningError(null);
      try { const r = await searchMeaning(query.trim(), docId); if (live) setMeaningHits(r); }
      catch (e) { if (live) { setMeaningHits([]); setMeaningError(e instanceof ApiError || e instanceof Error ? e.message : 'Search failed. Try again.'); } }
      finally { if (live) setMeaningBusy(false); }
    }, 450);
    return () => { live = false; clearTimeout(t); };
  }, [byMeaning, query, docId]);

  const hits = useMemo(() => (doc && query.trim().length > 1 ? searchDocument(doc.parsed, query) : []), [doc, query]);
  if (!doc) return <div className="empty"><p>Loading document…</p></div>;

  const annFor = (i: number) => annotations.filter((a) => a.utteranceIndex === i);
  const addAnnotation = async (kind: 'bookmark' | 'highlight' | 'note', i: number, body?: string) => {
    const u = utterances[i];
    if (!u) return;
    const now = Date.now();
    const id = uid();
    await db.annotations.add({ id, docId, kind, blockId: u.blockId, utteranceIndex: i, text: u.text, body, createdAt: now, updatedAt: now });
    await queueSync(kind === 'bookmark' ? 'bookmarks' : kind === 'highlight' ? 'highlights' : 'notes', id);
  };
  const removeAnnotation = async (id: string) => { await db.annotations.update(id, { deletedAt: Date.now(), updatedAt: Date.now() }); await queueSync('annotations', id, 'delete'); };
  const playFrom = (i: number) => { player.seekTo(i); if (!playing) player.play(); setFollow(true); };
  const jumpToBlock = (blockId: string) => {
    const first = byBlock.get(blockId)?.[0]?.i;
    if (first !== undefined) player.seekTo(first);
    setPanel(null);
    setTimeout(() => document.querySelector(`[data-b="${blockId}"]`)?.scrollIntoView({ block: 'center' }), 50);
  };
  const setMode = async (mode: ReadingMode) => { await db.docs.update(docId, { readingMode: mode, updatedAt: Date.now() }); await queueSync('documents', docId); };
  const applyCleanup = async () => {
    if (!cleanup) return;
    setBusy(true); setError(null);
    try { await reprocess(docId, cleanup, doc.readingMode); setPanel(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong while cleaning this document. Try again.'); }
    finally { setBusy(false); }
  };

  const explainBlock = async (blockId: string) => {
    if (!canExplain) { setExplains((m) => ({ ...m, [blockId]: { error: 'Explanations are included with Pro.' } })); return; }
    setExplains((m) => ({ ...m, [blockId]: { loading: true } }));
    try {
      await ensureDocumentSynced(docId);
      const data = await apiPost<Explanation>('/v1/ai/explain', { documentId: docId, blockId });
      setExplains((m) => ({ ...m, [blockId]: { data } }));
    } catch (e) {
      setExplains((m) => ({ ...m, [blockId]: { error: e instanceof ApiError || e instanceof Error ? e.message : 'Something went wrong. Try again.' } }));
    }
  };
  const listen = (text: string) => { player.pause(); speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = player.getSnapshot().rate; speechSynthesis.speak(u); };
  const explainUI = (blockId: string) => {
    if (!user) return null;
    const st = explains[blockId];
    return (
      <div className="explain">
        {!st?.data && <button className="chip" disabled={st?.loading} onClick={() => void explainBlock(blockId)}><Sparkles size={16} /> {st?.loading ? 'Explaining…' : 'Explain this'}</button>}
        {st?.error && <p role="alert" className="error-text">{st.error}</p>}
        {st?.data && (
          <aside className="explain-card">
            <p className="ai-label">AI-generated explanation. It can make mistakes.</p>
            <p>{st.data.explanation}</p>
            {st.data.keyPoints.length > 0 && <ul>{st.data.keyPoints.map((k, i) => <li key={i}>{k}</li>)}</ul>}
            {st.data.note && <p className="hint">{st.data.note}</p>}
            <div className="row-end">
              <button className="chip" onClick={() => listen([st.data!.explanation, ...st.data!.keyPoints].join('. '))}><Volume2 size={16} /> Listen</button>
              <button className="chip" onClick={() => setExplains((m) => { const { [blockId]: _gone, ...rest } = m; return rest; })}>Hide</button>
            </div>
          </aside>
        )}
      </div>
    );
  };

  const sentenceClass = (i: number) => {
    const anns = annFor(i);
    return ['sent', mine && ps.index === i ? 'now' : '', anns.some((a) => a.kind === 'highlight') ? 'hl' : '', selected === i ? 'sel' : ''].filter(Boolean).join(' ');
  };

  return (
    <article className="reader" onWheel={() => follow && setFollow(false)} onTouchMove={() => follow && setFollow(false)}>
      <header className="reader-head">
        <button className="icon-btn" onClick={onBack} aria-label="Back to library"><ArrowLeft size={22} /></button>
        <div className="reader-title">
          <h1>{doc.title}</h1>
          <p>{[doc.author, `${doc.durationMin} min`, MODE_LABELS[doc.readingMode].name].filter(Boolean).join(' · ')}</p>
        </div>
        <button className="icon-btn" onClick={() => setPanel(panel === 'ai' ? null : 'ai')} aria-label="Summaries and questions" aria-pressed={panel === 'ai'}><Sparkles size={22} /></button>
        <button className="icon-btn" onClick={() => setPanel(panel === 'contents' ? null : 'contents')} aria-label="Contents" aria-pressed={panel === 'contents'}><List size={22} /></button>
        <button className="icon-btn" onClick={() => setPanel(panel === 'search' ? null : 'search')} aria-label="Search in document" aria-pressed={panel === 'search'}><Search size={22} /></button>
        <button className="icon-btn" onClick={() => { setCleanup(doc.cleanup); setPanel(panel === 'settings' ? null : 'settings'); }} aria-label="Reading settings" aria-pressed={panel === 'settings'}><SlidersHorizontal size={22} /></button>
      </header>

      {panel === 'ai' && <div className="panel"><AiPanel doc={doc} onJump={(b) => jumpToBlock(b)} /></div>}
      {panel === 'contents' && (
        <nav className="panel" aria-label="Contents">
          <ul className="toc">
            {doc.parsed.sections.map((s) => {
              const first = utterances.findIndex((u) => u.sectionId === s.id);
              return (
                <li key={s.id} style={{ paddingLeft: Math.max(0, s.level - 1) * 16 }}>
                  <button className="link-btn" disabled={first < 0} onClick={() => { player.seekTo(first); setPanel(null); const b = s.blockIds[0]; setTimeout(() => document.querySelector(`[data-b="${b}"]`)?.scrollIntoView({ block: 'start' }), 50); }}>{s.title}</button>
                </li>
              );
            })}
          </ul>
        </nav>
      )}
      {panel === 'search' && (
        <div className="panel" role="search">
          <input className="text-input" type="search" autoFocus placeholder="Search this document" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search this document" />
          {canMeaning && <label className="check-row"><input type="checkbox" checked={byMeaning} onChange={(e) => setByMeaning(e.target.checked)} /> Search by meaning</label>}
          {byMeaning ? (
            <>
              {query.trim().length > 2 && meaningBusy && <p className="hint" role="status">Searching…</p>}
              {meaningError && <p role="alert" className="error-text">{meaningError}</p>}
              {query.trim().length > 2 && !meaningBusy && !meaningError && meaningHits.length === 0 && <p className="hint">Nothing close to that. A newly added document is prepared for this kind of search in the background, so try again in a minute.</p>}
              <ul className="results">{meaningHits.map((h) => <li key={h.blockId + h.snippet.slice(0, 10)}><button className="link-btn" onClick={() => jumpToBlock(h.blockId)}><strong>{h.sectionTitle}.</strong> {h.snippet}…</button></li>)}</ul>
            </>
          ) : (
            <>
              {query.trim().length > 1 && <p className="hint">{hits.length ? `${hits.length} ${hits.length === 1 ? 'match' : 'matches'}` : 'No matches. Try fewer or different words.'}</p>}
              <ul className="results">{hits.map((h) => <li key={h.blockId}><button className="link-btn" onClick={() => jumpToBlock(h.blockId)}>{h.snippet}</button></li>)}</ul>
            </>
          )}
        </div>
      )}
      {panel === 'settings' && cleanup && (
        <div className="panel">
          <label className="field">Reading mode
            <select value={doc.readingMode} onChange={(e) => void setMode(e.target.value as ReadingMode)}>
              {(Object.keys(MODE_LABELS) as ReadingMode[]).map((m) => <option key={m} value={m}>{MODE_LABELS[m].name}</option>)}
            </select>
            <span className="hint">{MODE_LABELS[doc.readingMode].blurb}</span>
          </label>
          <CleanupPanel report={doc.report} options={cleanup} onChange={setCleanup} />
          {error && <p role="alert" className="error-text">{error}</p>}
          <button className="btn primary" disabled={busy} onClick={() => void applyCleanup()}>{busy ? 'Cleaning…' : 'Apply cleanup'}</button>
        </div>
      )}

      <div className="reading-body reading">
        {doc.parsed.blocks.map((b) => {
          const us = byBlock.get(b.id);
          const skipped = !us;
          if (b.type === 'table') {
            return (
              <Fragment key={b.id}>
              <div data-b={b.id} className={`table-wrap ${skipped ? 'skipped' : ''}`}>
                <table><tbody>{(b.rows ?? []).map((r, ri) => <tr key={ri}>{r.map((c, ci) => (ri === 0 ? <th key={ci}>{c}</th> : <td key={ci}>{c}</td>))}</tr>)}</tbody></table>
              </div>
              {explainUI(b.id)}
              </Fragment>
            );
          }
          if (b.type === 'heading') {
            const i = us?.[0]?.i;
            const Tag = (`h${Math.min(4, Math.max(2, (b.level ?? 2) + 1))}`) as 'h2' | 'h3' | 'h4';
            return <Tag key={b.id} data-b={b.id} data-u={i} className={i !== undefined ? sentenceClass(i) : ''} onClick={() => i !== undefined && setSelected(i)}>{b.text}</Tag>;
          }
          const cls = b.type === 'quote' ? 'quote' : b.type === 'list_item' ? 'li' : b.type === 'caption' || b.type === 'footnote' ? 'caption' : 'para';
          const notes = (us ?? []).flatMap(({ i }) => annFor(i).filter((a) => a.kind === 'note'));
          return (
            <div key={b.id} data-b={b.id} className={`${cls} ${skipped ? 'skipped' : ''}`}>
              {b.type === 'list_item' && <span className="marker" aria-hidden>{b.ordered ? '•' : '–'}</span>}
              <p>
                {us ? us.map(({ u, i }) => (
                  <span key={u.id} data-u={i} className={sentenceClass(i)} onClick={() => setSelected(selected === i ? null : i)}>
                    {u.text}{annFor(i).some((a) => a.kind === 'bookmark') && <Bookmark size={13} className="bm" aria-label="Bookmarked" />}{' '}
                  </span>
                )) : b.text}
              </p>
              {isFigure(b) && explainUI(b.id)}
              {notes.map((n) => (
                <aside key={n.id} className="note"><span>{n.body}</span><button className="icon-btn small" aria-label="Delete note" onClick={() => void removeAnnotation(n.id)}><X size={14} /></button></aside>
              ))}
            </div>
          );
        })}
        <div className="reader-end" />
      </div>

      {!follow && playing && <button className="pill-btn" onClick={() => setFollow(true)}>Follow playback</button>}

      {selected !== null && utterances[selected] && (
        <div className="action-bar" role="toolbar" aria-label="Sentence actions">
          {noteDraft === null ? (
            <>
              <button className="chip" onClick={() => playFrom(selected)}><Play size={16} /> Play from here</button>
              <button className="chip" onClick={() => void addAnnotation('bookmark', selected)}><Bookmark size={16} /> Bookmark</button>
              <button className="chip" onClick={() => {
                const h = annFor(selected).find((a) => a.kind === 'highlight');
                if (h) void removeAnnotation(h.id); else void addAnnotation('highlight', selected);
              }}><Highlighter size={16} /> {annFor(selected).some((a) => a.kind === 'highlight') ? 'Remove highlight' : 'Highlight'}</button>
              <button className="chip" onClick={() => setNoteDraft('')}><StickyNote size={16} /> Note</button>
              <button className="icon-btn small" onClick={() => setSelected(null)} aria-label="Close actions"><X size={16} /></button>
            </>
          ) : (
            <form className="note-form" onSubmit={(e) => { e.preventDefault(); if (noteDraft.trim()) void addAnnotation('note', selected, noteDraft.trim()); setNoteDraft(null); }}>
              <input className="text-input" autoFocus value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} placeholder="Write a note" aria-label="Note" />
              <button className="btn primary" type="submit">Save note</button>
              <button className="btn" type="button" onClick={() => setNoteDraft(null)}>Cancel</button>
            </form>
          )}
        </div>
      )}

      <button className="fab" onClick={() => { if (mine) { player.toggle(); setFollow(true); } }} aria-label={playing ? 'Pause' : 'Listen'} disabled={!mine || !utterances.length}>
        {playing ? <Pause size={22} /> : <Play size={22} />}<span>{playing ? 'Pause' : 'Listen'}</span>
      </button>
    </article>
  );
}
