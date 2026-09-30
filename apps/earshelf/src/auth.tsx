import { createContext, useContext, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';

export const AuthContext = createContext<Session | null>(null);
/** The signed-in session shared by the whole app (null when signed out or running on this device only). */
export const useUser = () => useContext(AuthContext);

export function useSession(): { session: Session | null; ready: boolean } {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(!supabase);
  useEffect(() => {
    if (!supabase) return;
    void supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  return { session, ready };
}

export function SignIn({ onSkip }: { onSkip?: () => void }) {
  const [mode, setMode] = useState<'in' | 'up' | 'link'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase) return;
    setBusy(true); setMsg(null);
    try {
      if (mode === 'link') {
        const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin } });
        if (error) throw error;
        setMsg({ kind: 'info', text: 'Check your email for a sign-in link.' });
      } else if (mode === 'up') {
        const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: location.origin } });
        if (error) throw error;
        if (!data.session) setMsg({ kind: 'info', text: 'Account created. Check your email to confirm it, then sign in.' });
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : 'Something went wrong.';
      setMsg({ kind: 'error', text: /invalid login/i.test(m) ? 'That email and password do not match. Check them and try again, or create an account.' : m });
    } finally { setBusy(false); }
  };

  return (
    <main className="auth">
      <form className="auth-card stack" onSubmit={(e) => void submit(e)}>
        <h1 className="brand-big">earshelf</h1>
        <p className="hint">Your documents, read aloud. Sign in so your library follows you to every device.</p>
        <label className="field">Email
          <input className="text-input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {mode !== 'link' && (
          <label className="field">Password
            <input className="text-input" type="password" autoComplete={mode === 'up' ? 'new-password' : 'current-password'} required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
            {mode === 'up' && <span className="hint">At least 8 characters.</span>}
          </label>
        )}
        {msg && <p role={msg.kind === 'error' ? 'alert' : 'status'} className={msg.kind === 'error' ? 'error-text' : 'hint'}>{msg.text}</p>}
        <button className="btn primary" type="submit" disabled={busy}>{busy ? 'One moment…' : mode === 'in' ? 'Sign in' : mode === 'up' ? 'Create account' : 'Email me a link'}</button>
        <div className="auth-links">
          {mode !== 'in' && <button type="button" className="link-btn" onClick={() => setMode('in')}>I have an account</button>}
          {mode !== 'up' && <button type="button" className="link-btn" onClick={() => setMode('up')}>Create an account</button>}
          {mode !== 'link' && <button type="button" className="link-btn" onClick={() => setMode('link')}>Use an email link instead</button>}
          {onSkip && <button type="button" className="link-btn" onClick={onSkip}>Continue on this device only</button>}
        </div>
      </form>
    </main>
  );
}
