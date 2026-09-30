import { config } from './config.ts';

/**
 * Legacy service_role keys are JWTs and go in both headers. New sb_secret_ keys are not JWTs:
 * Supabase requires them in the apikey header only, never in Authorization.
 */
export function keyHeaders(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return key.startsWith('eyJ') ? { apikey: key, Authorization: `Bearer ${key}`, ...extra } : { apikey: key, ...extra };
}
const svcHeaders = (extra: Record<string, string> = {}) => keyHeaders(config.serviceKey, extra);

export async function getUser(token: string): Promise<{ id: string; email?: string } | null> {
  const res = await fetch(`${config.supabaseUrl}/auth/v1/user`, { headers: { apikey: config.anonKey, Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const u = (await res.json()) as { id?: string; email?: string };
  return u.id ? { id: u.id, email: u.email } : null;
}

export async function rest<T = unknown>(path: string, init: { method?: string; body?: unknown; prefer?: string } = {}): Promise<T> {
  const res = await fetch(`${config.supabaseUrl}/rest/v1/${path}`, {
    method: init.method ?? 'GET',
    headers: svcHeaders({ 'Content-Type': 'application/json', Prefer: init.prefer ?? 'return=representation' }),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) throw new Error(`Supabase ${path}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');

export async function storageDownload(bucket: string, path: string): Promise<Buffer | null> {
  const res = await fetch(`${config.supabaseUrl}/storage/v1/object/${bucket}/${enc(path)}`, { headers: svcHeaders() });
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`Storage download ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function storageUpload(bucket: string, path: string, body: Buffer | string, contentType: string): Promise<void> {
  const res = await fetch(`${config.supabaseUrl}/storage/v1/object/${bucket}/${enc(path)}`, {
    method: 'POST', headers: svcHeaders({ 'Content-Type': contentType, 'x-upsert': 'true' }), body: typeof body === 'string' ? body : new Uint8Array(body),
  });
  if (!res.ok) throw new Error(`Storage upload ${res.status}: ${await res.text()}`);
}

export async function signedUrl(bucket: string, path: string, expiresIn = 60 * 60 * 24): Promise<string> {
  const res = await fetch(`${config.supabaseUrl}/storage/v1/object/sign/${bucket}/${enc(path)}`, {
    method: 'POST', headers: svcHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ expiresIn }),
  });
  if (!res.ok) throw new Error(`Sign URL ${res.status}`);
  const { signedURL } = (await res.json()) as { signedURL: string };
  return `${config.supabaseUrl}/storage/v1${signedURL}`;
}

async function listPrefix(bucket: string, prefix: string): Promise<string[]> {
  const res = await fetch(`${config.supabaseUrl}/storage/v1/object/list/${bucket}`, { method: 'POST', headers: svcHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ prefix, limit: 1000, offset: 0 }) });
  if (!res.ok) throw new Error(`Storage list ${res.status}`);
  const entries = (await res.json()) as Array<{ name: string; id: string | null }>;
  const files: string[] = [];
  for (const e of entries) {
    if (e.id) files.push(`${prefix}/${e.name}`);
    else files.push(...(await listPrefix(bucket, `${prefix}/${e.name}`)));
  }
  return files;
}

/** Removes every stored file and row belonging to the user. Billing records are kept for accounting. */
export async function deleteUserContent(userId: string): Promise<void> {
  for (const bucket of ['originals', 'audio']) {
    const files = await listPrefix(bucket, userId);
    for (let i = 0; i < files.length; i += 100) {
      const res = await fetch(`${config.supabaseUrl}/storage/v1/object/${bucket}`, { method: 'DELETE', headers: svcHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ prefixes: files.slice(i, i + 100) }) });
      if (!res.ok) throw new Error(`Storage delete ${res.status}`);
    }
  }
  await rest(`documents?user_id=eq.${userId}`, { method: 'DELETE', prefer: 'return=minimal' }); // cascades to sections, blocks, chunks
  for (const t of ['wells', 'playlists', 'audio_assets', 'playback_progress', 'bookmarks', 'highlights', 'notes', 'downloads', 'search_queries', 'recommendations', 'notifications', 'processing_jobs', 'ai_generations', 'document_pronunciations', 'user_preferences', 'usage_events'])
    await rest(`${t}?user_id=eq.${userId}`, { method: 'DELETE', prefer: 'return=minimal' });
}
