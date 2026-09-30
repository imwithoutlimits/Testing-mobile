import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft, Layers, Trash2 } from 'lucide-react';
import { isWeak, pickDue, previewInterval, schedule } from '@wells/core';
import type { Grade } from '@wells/core';
import { db, type CardRecord } from '../db';

const GRADES: Array<{ g: Grade; label: string }> = [{ g: 'again', label: 'Again' }, { g: 'hard', label: 'Hard' }, { g: 'good', label: 'Good' }, { g: 'easy', label: 'Easy' }];
const liveCards = () => db.cards.filter((c) => !c.deletedAt).toArray();

export function DueCard({ onReview }: { onReview: () => void }) {
  const cards = useLiveQuery(liveCards, [], [] as CardRecord[]);
  const now = Date.now();
  const due = cards.filter((c) => c.dueAt <= now).length;
  if (!cards.length) return null;
  return (
    <button className="due-card" onClick={onReview}>
      <Layers size={22} aria-hidden />
      <span><strong>{due > 0 ? `${due} ${due === 1 ? 'card' : 'cards'} to review` : 'All caught up'}</strong><span className="doc-meta">{cards.length} saved · tap to practise{due === 0 ? ' anyway' : ''}</span></span>
    </button>
  );
}

export function Review({ onClose, onOpen }: { onClose: () => void; onOpen: (docId: string, blockId?: string) => void }) {
  const all = useLiveQuery(liveCards, [], [] as CardRecord[]);
  const [weakOnly, setWeakOnly] = useState(false);
  const [queue, setQueue] = useState<string[] | null>(null);
  const [shown, setShown] = useState(false);
  const [done, setDone] = useState(0);

  const weakCount = useMemo(() => all.filter(isWeak).length, [all]);
  const start = () => {
    const due = pickDue(all, Date.now(), 30, weakOnly);
    // With nothing due, offer a light practice round rather than an empty screen.
    setQueue((due.length ? due : [...all].filter((c) => !weakOnly || isWeak(c)).sort((a, b) => a.dueAt - b.dueAt).slice(0, 10)).map((c) => c.id));
    setDone(0); setShown(false);
  };
  const card = queue?.length ? all.find((c) => c.id === queue[0]) : undefined;

  const grade = async (g: Grade) => {
    if (!card || !queue) return;
    const next = schedule(card, g);
    await db.cards.update(card.id, { ...next, updatedAt: Date.now() });
    setQueue(g === 'again' ? [...queue.slice(1), card.id] : queue.slice(1)); // forgotten cards come back once more this session
    setDone((n) => n + 1); setShown(false);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input,textarea,select')) return;
      if (!shown && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); setShown(true); }
      else if (shown && '1234'.includes(e.key) && e.key) void grade(GRADES[Number(e.key) - 1].g);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <section className="page">
      <header className="page-head"><button className="icon-btn" onClick={onClose} aria-label="Back"><ArrowLeft size={22} /></button><h1>Review</h1></header>

      {!queue ? (
        <div className="stack">
          <p>{all.length} saved {all.length === 1 ? 'card' : 'cards'}. Cards you find easy come back less often, and cards you forget come back sooner.</p>
          <label className="check-row"><input type="checkbox" checked={weakOnly} onChange={(e) => setWeakOnly(e.target.checked)} disabled={weakCount === 0} /> Only cards I keep forgetting ({weakCount})</label>
          <button className="btn primary" onClick={start} disabled={all.length === 0}>Start</button>
          {all.length === 0 && <p className="hint">Make flashcards from the sparkle button in any document, then save them here.</p>}
        </div>
      ) : !card ? (
        <div className="empty"><h2>Nicely done</h2><p>You reviewed {done} {done === 1 ? 'card' : 'cards'}. Come back when more are due.</p><button className="btn" onClick={onClose}>Finish</button></div>
      ) : (
        <div className="stack">
          <p className="hint" role="status">{queue!.length} left</p>
          <div className="review-card reading">{card.front}</div>
          {!shown ? <button className="btn primary" onClick={() => setShown(true)}>Show answer</button> : (
            <>
              <div className="review-card back reading">{card.back}</div>
              <div className="grades" role="group" aria-label="How well did you remember?">
                {GRADES.map(({ g, label }, i) => <button key={g} className={`btn grade-${g}`} onClick={() => void grade(g)}><span>{label}</span><span className="doc-meta">{previewInterval(card, g)} · {i + 1}</span></button>)}
              </div>
            </>
          )}
          <div className="row-end">
            {card.docId && <button className="link-btn" onClick={() => onOpen(card.docId!, card.blockId)}>See where this came from</button>}
            <button className="icon-btn small" aria-label="Delete this card" onClick={() => void db.cards.update(card.id, { deletedAt: Date.now(), updatedAt: Date.now() }).then(() => { setQueue(queue!.slice(1)); setShown(false); })}><Trash2 size={16} /></button>
          </div>
        </div>
      )}
    </section>
  );
}
