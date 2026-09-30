import { useEffect, useState } from 'react';
import { Activity as ActivityIcon, FolderOpen, Home as HomeIcon, Search as SearchIcon, User, WifiOff } from 'lucide-react';
import { ensureDefaultWells, getSetting } from './db';
import { AuthContext, SignIn, useSession } from './auth';
import { supabase } from './supabase';
import { startSync, stopSync, syncNow, useSyncStatus } from './sync';
import { installServerVoice } from './serverVoice';
import { player, usePlan, useSetting } from './hooks';
import { hasFeature } from '@wells/billing/src/plans.ts';
import { setMonitorUser } from './monitor';
import { useAutoIndex } from './semantic';
import { useCapabilities } from './serverVoice';
import { Review } from './views/Review';
import { PlayerBar } from './components/PlayerBar';
import { ImportSheet } from './components/ImportSheet';
import { Home } from './views/Home';
import { Wells } from './views/Wells';
import { Search } from './views/Search';
import { Activity } from './views/Activity';
import { Settings } from './views/Settings';
import { Reader } from './views/Reader';

type View = 'home' | 'wells' | 'search' | 'activity' | 'settings';
const NAV: Array<{ id: View; label: string; Icon: typeof HomeIcon }> = [
  { id: 'home', label: 'Home', Icon: HomeIcon },
  { id: 'wells', label: 'Wells', Icon: FolderOpen },
  { id: 'search', label: 'Search', Icon: SearchIcon },
  { id: 'activity', label: 'Activity', Icon: ActivityIcon },
  { id: 'settings', label: 'Profile', Icon: User },
];

export default function App() {
  const { session, ready } = useSession();
  const [localOnly, setLocalOnly] = useState(() => localStorage.getItem('earshelf-local-only') === '1');
  const sync = useSyncStatus();
  const plan = usePlan();
  const caps = useCapabilities(!!session);
  const [reviewing, setReviewing] = useState(false);
  // Documents are prepared for search by meaning in the background, after each sync.
  useAutoIndex(!!session && hasFeature(plan, 'semantic_search') && !!caps?.embeddings, sync.lastSyncedAt);
  useEffect(() => { setMonitorUser(session?.user.id); }, [session?.user.id]);
  const [view, setView] = useState<View>('home');
  const [reader, setReader] = useState<{ docId: string; blockId?: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [theme] = useSetting<'system' | 'light' | 'dark'>('theme', 'system');

  useEffect(() => { installServerVoice(); }, []);

  useEffect(() => {
    if (!session) return;
    void startSync(session);
    return () => stopSync();
  }, [session?.user.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void ensureDefaultWells();
    void getSetting('rate', 1).then((r) => player.setRate(r));
    void getSetting<string | null>('voiceURI', null).then((v) => player.setVoice(v));
  }, []);

  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === ' ' && t.tagName !== 'BUTTON') { e.preventDefault(); player.toggle(); }
      else if (e.key === 'j') player.back(15);
      else if (e.key === 'l') player.forward(30);
      else if (e.key === 'ArrowLeft' && t.tagName !== 'INPUT') player.previous();
      else if (e.key === 'ArrowRight' && t.tagName !== 'INPUT') player.next();
      else if (e.key === '[') player.setRate(player.getSnapshot().rate - 0.25);
      else if (e.key === ']') player.setRate(player.getSnapshot().rate + 0.25);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const open = (docId: string, blockId?: string) => setReader({ docId, blockId });

  if (!ready) return <div className="splash" role="status">Loading…</div>;
  if (supabase && !session && !localOnly) return <SignIn onSkip={() => { localStorage.setItem('earshelf-local-only', '1'); setLocalOnly(true); }} />;

  return (
    <AuthContext.Provider value={session}>
    <div className="shell">
      <nav className="sidenav" aria-label="Primary">
        <div className="brand">earshelf</div>
        {NAV.map(({ id, label, Icon }) => (
          <button key={id} className={view === id && !reader ? 'nav-item active' : 'nav-item'} aria-current={view === id && !reader ? 'page' : undefined} onClick={() => { setReader(null); setReviewing(false); setView(id); }}>
            <Icon size={22} /><span>{label}</span>
          </button>
        ))}
      </nav>

      <main className="content">
        {!online && <div className="banner" role="status"><WifiOff size={16} /> You’re offline. Your library and device voices still work.</div>}
        {online && sync.state === 'error' && <div className="banner" role="alert">Your changes are saved on this device but could not sync yet. <button className="link-btn inline" onClick={() => void syncNow(true)}>Try again</button></div>}
        {reader ? <Reader docId={reader.docId} focusBlockId={reader.blockId} onBack={() => setReader(null)} /> : reviewing ? <Review onClose={() => setReviewing(false)} onOpen={(d, b) => { setReviewing(false); open(d, b); }} /> : (
          <>
            {view === 'home' && <Home onOpen={open} onImport={() => setImporting(true)} onReview={() => setReviewing(true)} />}
            {view === 'wells' && <Wells onOpen={open} />}
            {view === 'search' && <Search onOpen={open} />}
            {view === 'activity' && <Activity onOpen={open} onReview={() => setReviewing(true)} />}
            {view === 'settings' && <Settings />}
          </>
        )}
      </main>

      <PlayerBar onOpenReader={(docId) => open(docId)} />

      <nav className="bottomnav" aria-label="Primary">
        {NAV.map(({ id, label, Icon }) => (
          <button key={id} className={view === id && !reader ? 'nav-item active' : 'nav-item'} aria-current={view === id && !reader ? 'page' : undefined} onClick={() => { setReader(null); setReviewing(false); setView(id); }}>
            <Icon size={24} /><span>{label}</span>
          </button>
        ))}
      </nav>

      {importing && <ImportSheet onClose={() => setImporting(false)} onDone={(id) => { setImporting(false); open(id); }} />}
    </div>
    </AuthContext.Provider>
  );
}
