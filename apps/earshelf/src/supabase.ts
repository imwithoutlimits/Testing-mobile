import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { reportError } from './monitor';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY;

/** null when Supabase is not configured: the app then runs on this device only. */
export const supabase: SupabaseClient | null = url && key
  ? createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : null;

export const apiUrl = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

export async function accessToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

async function call(path: string, init: RequestInit): Promise<Response> {
  if (!apiUrl) throw new ApiError(0, 'no_api', 'The earshelf server is not connected yet.');
  const token = await accessToken();
  if (!token) throw new ApiError(401, 'unauthorized', 'Sign in to use this.');
  let res: Response;
  try { res = await fetch(`${apiUrl}${path}`, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } }); }
  catch { throw new ApiError(0, 'network', 'Could not reach the earshelf server. Check your connection and try again.'); }
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    if (res.status >= 500) reportError(new Error(`${path.split('?')[0]} returned ${res.status}`), 'api', { status: res.status });
    throw new ApiError(res.status, j.error ?? 'error', j.message ?? `Request failed (${res.status}).`);
  }
  return res;
}
export const apiGet = async <T,>(path: string) => (await call(path, {})).json() as Promise<T>;
export const apiPost = async <T,>(path: string, body: unknown) => (await call(path, { method: 'POST', body: JSON.stringify(body) })).json() as Promise<T>;
export const apiBlob = async (path: string, body: unknown) => (await call(path, { method: 'POST', body: JSON.stringify(body) })).blob();
