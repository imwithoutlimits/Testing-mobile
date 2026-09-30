import { useRef, useState } from 'react';
import { Copy, Square, Volume2 } from 'lucide-react';
import { ApiError, apiPost } from '../supabase';
import { NEW_CARD_STATE } from '@wells/core';
import { db, uid } from '../db';
import { ensureDocumentSynced } from '../sync';
import { useUser } from '../auth';
import { player } from '../hooks';
import type { DocRecord } from '../db';

type Tab = 'summary' | 'ask' | 'quiz';
const KINDS: Array<[string, string]> = [
  ['30s', '30-second overview'], ['2min', '2-minute summary'], ['5min', '5-minute summary'], ['10min', '10-minute briefing'], ['executive', 'Executive summary'], ['beginner', 'Beginner explanation'],
  ['key-arguments', 'Key arguments'], ['action-items', 'Action items'], ['definitions', 'Definitions'], ['statistics', 'Statistics'], ['quotes', 'Notable quotes'], ['dates-names', 'Dates and names'],
];
interface Summary { label: string; text: string; items: string[]; sources: Array<{ sectionId: string; title: string }> }
interface Answer { found: boolean; answer: string; citations: Array<{ passage: string; sectionId: string; sectionTitle: string; blockId: string; snippet: string }> }
interface Question { type: 'mcq' | 'tf' | 'fill'; question: string; options?: string[]; answer: string | number | boolean; explanation: string; blockId: string }
interface Card { front: string; back: string; blockId: string }

export function AiPanel({ doc, onJump }: { doc: DocRecord; onJump: (blockId: string) => void }) {
  const user = useUser();
  const [tab, setTab] = useState<Tab>('summary');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState('2min');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [questions, setQuestions] = useState<Question[] | null>(null);
  const [cards, setCards] = useState<Card[] | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await ensureDocumentSynced(doc.id); await fn(); }
    catch (e) { setError(e instanceof ApiError || e instanceof Error ? e.message : 'Something went wrong. Try again.'); }
    finally { setBusy(false); }
  };
  const saveCards = async (items: Array<{ front: string; back: string; blockId: string }>) => {
    const now = Date.now();
    await db.cards.bulkAdd(items.map((c) => ({ id: uid(), docId: doc.id, front: c.front, back: c.back, blockId: c.blockId, ...NEW_CARD_STATE(now), createdAt: now, updatedAt: now })));
    setSaved(`Saved ${items.length} ${items.length === 1 ? 'card' : 'cards'} for review. Find them under Home or Activity.`);
  };
  const questionToCard = (q: Question) => {
    const L = 'ABCD';
    if (q.type === 'mcq') return { front: `${q.question}\n${q.options!.map((o, i) => `${L[i]}. ${o}`).join('\n')}`, back: `${L[q.answer as number]}. ${q.options![q.answer as number]}\n\n${q.explanation}`, blockId: q.blockId };
    if (q.type === 'tf') return { front: `${q.question}\n(True or false?)`, back: `${q.answer ? 'True' : 'False'}. ${q.explanation}`, blockId: q.blockId };
    return { front: q.question, back: `${q.answer}. ${q.explanation}`, blockId: q.blockId };
  };
  const jumpSection = (sectionId: string) => { const b = doc.parsed.sections.find((s) => s.id === sectionId)?.blockIds[0]; if (b) onJump(b); };
  const speak = (text: string) => {
    if (speaking) { speechSynthesis.cancel(); setSpeaking(false); return; }
    player.pause();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = player.getSnapshot().rate;
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    setSpeaking(true);
    speechSynthesis.speak(u);
  };

  if (!user) return <p className="hint">Sign in to use summaries and questions.</p>;

  return (
    <div className="ai stack">
      <p className="ai-label">AI-generated. It can make mistakes, so check anything important against the document.</p>
      <div className="tabs" role="tablist">
        {([['summary', 'Summary'], ['ask', 'Ask'], ['quiz', 'Quiz']] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'tab active' : 'tab'} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {tab === 'summary' && (
        <>
          <div className="inline-form">
            <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Summary type">{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            <button className="btn primary" disabled={busy} onClick={() => void run(async () => setSummary(await apiPost<Summary>('/v1/ai/summary', { documentId: doc.id, kind })))}>{busy ? 'Working…' : 'Create'}</button>
          </div>
          {summary && (
            <div className="ai-result">
              <h3>{summary.label}</h3>
              {summary.text && <p className="reading">{summary.text}</p>}
              {summary.items.length > 0 && <ul className="reading">{summary.items.map((i, n) => <li key={n}>{i}</li>)}</ul>}
              {summary.sources.length > 0 && <p className="hint">From: {summary.sources.map((s) => <button key={s.sectionId} className="link-btn inline" onClick={() => jumpSection(s.sectionId)}>{s.title}</button>)}</p>}
              <div className="row-end">
                <button className="chip" onClick={() => speak([summary.text, ...summary.items].filter(Boolean).join('. '))}>{speaking ? <Square size={16} /> : <Volume2 size={16} />} {speaking ? 'Stop' : 'Listen'}</button>
                <button className="chip" onClick={() => void navigator.clipboard?.writeText([summary.text, ...summary.items.map((i) => `- ${i}`)].filter(Boolean).join('\n'))}><Copy size={16} /> Copy</button>
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'ask' && (
        <>
          <form className="inline-form" onSubmit={(e) => { e.preventDefault(); if (question.trim().length >= 3) void run(async () => setAnswer(await apiPost<Answer>('/v1/ai/ask', { documentId: doc.id, question }))); }}>
            <input className="text-input" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask about this document" aria-label="Question" maxLength={500} />
            <button className="btn primary" type="submit" disabled={busy || question.trim().length < 3}>{busy ? 'Thinking…' : 'Ask'}</button>
          </form>
          {answer && (
            <div className="ai-result">
              <p className={`reading ${answer.found ? '' : 'muted'}`}>{answer.answer}</p>
              {answer.citations.map((c) => <button key={c.passage} className="link-btn snippet" onClick={() => onJump(c.blockId)}><strong>{c.sectionTitle}.</strong> {c.snippet}…</button>)}
              {answer.found && <div className="row-end"><button className="chip" onClick={() => speak(answer.answer)}>{speaking ? <Square size={16} /> : <Volume2 size={16} />} {speaking ? 'Stop' : 'Listen'}</button></div>}
            </div>
          )}
        </>
      )}

      {tab === 'quiz' && (
        <>
          <div className="row-end">
            <button className="btn" disabled={busy} onClick={() => void run(async () => { setCards(null); setQuestions((await apiPost<{ questions: Question[] }>('/v1/ai/quiz', { documentId: doc.id, count: 8 })).questions); })}>Make a quiz</button>
            <button className="btn" disabled={busy} onClick={() => void run(async () => { setQuestions(null); setCards((await apiPost<{ cards: Card[] }>('/v1/ai/quiz', { documentId: doc.id, kind: 'flashcards', count: 10 })).cards); })}>Make flashcards</button>
          </div>
          {busy && <p className="hint" role="status">Working…</p>}
          {questions && <ol className="quiz">{questions.map((q, i) => <QuizItem key={i} q={q} onSource={() => onJump(q.blockId)} />)}</ol>}
          {questions && <div className="row-end"><button className="btn" onClick={() => void saveCards(questions.map(questionToCard))}>Save all {questions.length} for review</button></div>}
          {cards && <Flashcards cards={cards} onSource={onJump} />}
          {cards && <div className="row-end"><button className="btn" onClick={() => void saveCards(cards)}>Save all {cards.length} for review</button></div>}
          {saved && <p role="status" className="ok-text">{saved}</p>}
        </>
      )}
      {error && <p role="alert" className="error-text">{error}</p>}
    </div>
  );
}

function QuizItem({ q, onSource }: { q: Question; onSource: () => void }) {
  const [pick, setPick] = useState<string | number | boolean | null>(null);
  const [typed, setTyped] = useState('');
  const [shown, setShown] = useState(false);
  const correct = q.type === 'fill' ? typed.trim().toLowerCase() === String(q.answer).toLowerCase() : pick === q.answer;
  return (
    <li className="quiz-item">
      <p className="reading">{q.question}</p>
      {q.type === 'mcq' && q.options?.map((o, i) => <label key={i} className="check-row"><input type="radio" name={q.question} checked={pick === i} onChange={() => setPick(i)} disabled={shown} /> {o}</label>)}
      {q.type === 'tf' && [true, false].map((v) => <label key={String(v)} className="check-row"><input type="radio" name={q.question} checked={pick === v} onChange={() => setPick(v)} disabled={shown} /> {v ? 'True' : 'False'}</label>)}
      {q.type === 'fill' && <input className="text-input" value={typed} onChange={(e) => setTyped(e.target.value)} disabled={shown} aria-label="Your answer" />}
      {!shown ? <button className="btn" onClick={() => setShown(true)} disabled={q.type === 'fill' ? !typed.trim() : pick === null}>Check</button> : (
        <p role="status" className={correct ? 'ok-text' : 'error-text'}>{correct ? 'Correct. ' : `Not quite. The answer is ${q.type === 'mcq' ? q.options![q.answer as number] : q.type === 'tf' ? (q.answer ? 'True' : 'False') : q.answer}. `}<span className="muted">{q.explanation}</span> <button className="link-btn inline" onClick={onSource}>See where</button></p>
      )}
    </li>
  );
}

function Flashcards({ cards, onSource }: { cards: Card[]; onSource: (blockId: string) => void }) {
  const [i, setI] = useState(0);
  const [flip, setFlip] = useState(false);
  const c = cards[i];
  const go = (d: number) => { setI((i + d + cards.length) % cards.length); setFlip(false); };
  return (
    <div className="stack">
      <button className="flashcard reading" onClick={() => setFlip(!flip)} aria-label={flip ? 'Show front' : 'Show back'}>{flip ? c.back : c.front}</button>
      <div className="row-end"><span className="hint grow">{i + 1} of {cards.length}</span>
        <button className="btn" onClick={() => go(-1)}>Previous</button><button className="btn" onClick={() => onSource(c.blockId)}>See where</button><button className="btn primary" onClick={() => go(1)}>Next</button></div>
    </div>
  );
}
