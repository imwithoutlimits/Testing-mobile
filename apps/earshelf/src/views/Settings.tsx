import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Lock, Trash2 } from 'lucide-react';
import type { ReadingMode } from '@wells/core';
import { minimumPlanFor } from '@wells/billing/src/plans.ts';
import { db, deleteAllUserContent, uid } from '../db';
import { MODE_LABELS, VOICE_PROFILES, player, useHasFeature, usePlan, useSetting } from '../hooks';
import { NaturalVoice } from '../components/NaturalVoice';
import { useUser } from '../auth';
import { ApiError, apiPost, apiUrl, supabase } from '../supabase';
import { pendingChanges, stopSync, syncNow, useSyncStatus } from '../sync';
import { checkoutUrl } from '../billing';

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n > 1e8 ? 0 : 1)} MB`;
const ago = (t?: number) => (!t ? 'never' : Date.now() - t < 60_000 ? 'just now' : `${Math.round((Date.now() - t) / 60_000)} min ago`);

export function Settings() {
  const user = useUser();
  const plan = usePlan();
  const sync = useSyncStatus();
  const pending = useLiveQuery(() => db.outbox.count(), [], 0);
  const canPron = useHasFeature('pronunciation');
  const [theme, setTheme] = useSetting<'system' | 'light' | 'dark'>('theme', 'system');
  const [profile, setProfile] = useSetting('voiceProfile', 'calm-nonfiction');
  const [rate, setRate] = useSetting('rate', 1);
  const [pause, setPause] = useSetting('pauseScale', 1);
  const [mode, setMode] = useSetting<ReadingMode>('defaultMode', 'clean');
  const prons = useLiveQuery(() => db.pron.toArray(), [], []);
  const [term, setTerm] = useState('');
  const [say, setSay] = useState('');
  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { void navigator.storage?.estimate?.().then((e) => setUsage({ used: e.usage ?? 0, quota: e.quota ?? 0 })); }, [prons.length]);

  const chooseProfile = (id: string) => {
    const p = VOICE_PROFILES.find((x) => x.id === id);
    if (!p) return;
    setProfile(id); setRate(p.rate); setPause(p.pause); setMode(p.mode); player.setRate(p.rate);
  };

  const signOut = async () => {
    if (!supabase) return;
    setBusy(true); setNote(null);
    await syncNow(false);
    if ((await pendingChanges()) > 0) { setNote('Some changes have not reached the server yet. Connect to the internet and try again, so nothing is lost.'); setBusy(false); return; }
    player.pause(); stopSync();
    await deleteAllUserContent(); // this device's copy; your library stays safe on the server
    await supabase.auth.signOut();
    location.reload();
  };

  const wipe = async () => {
    setBusy(true); setNote(null);
    try {
      if (user && apiUrl) await apiPost('/v1/account/delete-content', {});
      player.pause(); stopSync();
      await deleteAllUserContent();
      location.reload();
    } catch (e) {
      setNote(e instanceof ApiError || e instanceof Error ? `${e.message} Nothing was deleted from your account.` : 'Something went wrong. Nothing was deleted from your account.');
      setBusy(false);
    }
  };

  const up = (p: 'plus' | 'pro') => user ? checkoutUrl(p, { id: user.user.id, email: user.user.email }) : null;

  return (
    <section className="page">
      <header className="page-head"><h1>Profile</h1></header>

      {supabase && (
        <div className="card stack">
          <h2 className="sub">Account</h2>
          {user ? (
            <>
              <p>{user.user.email}</p>
              <p className="hint" role="status">
                {sync.state === 'syncing' ? 'Syncing…' : sync.state === 'offline' ? 'Offline. Changes will sync when you reconnect.' : sync.state === 'error' ? `Sync problem: ${sync.error}` : `Up to date · synced ${ago(sync.lastSyncedAt)}`}
                {pending > 0 && ` · ${pending} ${pending === 1 ? 'change' : 'changes'} waiting`}
              </p>
              <div className="row-end">
                <button className="btn" onClick={() => void syncNow(true)} disabled={sync.state === 'syncing'}>Sync now</button>
                <button className="btn" onClick={() => void signOut()} disabled={busy}>Sign out</button>
              </div>
            </>
          ) : <p className="hint">You are using earshelf on this device only. Sign in to sync.</p>}
          {note && <p role="alert" className="error-text">{note}</p>}
        </div>
      )}

      <div className="card stack">
        <h2 className="sub">Plan</h2>
        <p>You’re on the <strong>{plan}</strong> plan. {plan === 'free' ? 'Free includes 5 documents, device voices and basic cleanup.' : plan === 'plus' ? 'Plus includes natural voices, OCR, offline audio, summaries and sync.' : 'Pro includes everything, including questions, quizzes and audio export.'}</p>
        {user && plan !== 'pro' && (
          <div className="row-end">
            {plan === 'free' && up('plus') && <a className="btn" href={up('plus')!}>Upgrade to Plus</a>}
            {up('pro') && <a className="btn primary" href={up('pro')!}>Upgrade to Pro</a>}
          </div>
        )}
        {plan !== 'free' && import.meta.env.VITE_LS_PORTAL_URL && <a className="link-btn" href={import.meta.env.VITE_LS_PORTAL_URL}>Manage billing</a>}
        <p className="hint">Your plan updates a moment after payment, once it is confirmed.</p>
      </div>

      <div className="card stack">
        <h2 className="sub">Listening</h2>
        <label className="field">Voice style
          <select value={profile} onChange={(e) => chooseProfile(e.target.value)}>
            {VOICE_PROFILES.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.blurb}</option>)}
          </select>
          <span className="hint">A style sets pace, pauses and reading mode. Choose the voice itself below or in the player.</span>
        </label>
        <label className="field">Speed: {rate}×
          <input type="range" min={0.5} max={2} step={0.05} value={rate} onChange={(e) => { const r = Number(e.target.value); setRate(r); player.setRate(r); }} />
        </label>
        <label className="field">Pause length: {Math.round(pause * 100)}%
          <input type="range" min={0.5} max={2} step={0.1} value={pause} onChange={(e) => setPause(Number(e.target.value))} />
        </label>
        <label className="field">Default reading mode
          <select value={mode} onChange={(e) => setMode(e.target.value as ReadingMode)}>
            {(Object.keys(MODE_LABELS) as ReadingMode[]).map((m) => <option key={m} value={m}>{MODE_LABELS[m].name}</option>)}
          </select>
        </label>
      </div>

      <div className="card stack">
        <h2 className="sub">Natural voices</h2>
        <NaturalVoice />
      </div>

      <div className="card stack">
        <h2 className="sub">Appearance</h2>
        <label className="field">Theme
          <select value={theme} onChange={(e) => setTheme(e.target.value as 'system' | 'light' | 'dark')}>
            <option value="system">Match my device</option><option value="light">Light</option><option value="dark">Dark</option>
          </select>
        </label>
      </div>

      <div className="card stack">
        <h2 className="sub">Pronunciations</h2>
        {!canPron ? (
          <p className="locked"><Lock size={16} /> Custom pronunciations are included with {minimumPlanFor('pronunciation')}.</p>
        ) : (
          <>
            <form className="inline-form" onSubmit={(e) => { e.preventDefault(); if (!term.trim() || !say.trim()) return; void db.pron.add({ id: uid(), term: term.trim(), say: say.trim() }); setTerm(''); setSay(''); }}>
              <input className="text-input" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Written as (NASA)" aria-label="Written as" />
              <input className="text-input" value={say} onChange={(e) => setSay(e.target.value)} placeholder="Say it as (nassa)" aria-label="Say it as" />
              <button className="btn primary" type="submit" disabled={!term.trim() || !say.trim()}>Add</button>
            </form>
            {prons.length === 0 ? <p className="hint">No custom pronunciations yet.</p> : (
              <ul className="check-list">{prons.map((p) => <li key={p.id}><span>{p.term} → {p.say}</span><button className="icon-btn small" aria-label={`Remove ${p.term}`} onClick={() => void db.pron.delete(p.id)}><Trash2 size={16} /></button></li>)}</ul>
            )}
          </>
        )}
      </div>

      <div className="card stack">
        <h2 className="sub">Your data</h2>
        <p>{usage ? `${mb(usage.used)} used on this device${usage.quota ? ` of about ${mb(usage.quota)} available` : ''}.` : 'Storage use is not available in this browser.'}</p>
        {!confirm ? (
          <button className="btn danger" onClick={() => setConfirm(true)}><Trash2 size={16} /> Delete all my content</button>
        ) : (
          <div className="error-box">
            <p>{user ? 'This permanently deletes every document, note, highlight, well, setting and generated audio from your account and this device. Your account and billing stay.' : 'This removes every document, note, highlight, well and setting from this device.'} It can’t be undone.</p>
            <div className="row-end"><button className="btn" onClick={() => setConfirm(false)}>Keep my content</button>
              <button className="btn danger" disabled={busy} onClick={() => void wipe()}>{busy ? 'Deleting…' : 'Delete everything'}</button></div>
          </div>
        )}
        {note && !supabase && <p role="alert" className="error-text">{note}</p>}
      </div>
    </section>
  );
}
