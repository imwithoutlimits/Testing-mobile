// Small error reporter that speaks Sentry's envelope format, so it works with Sentry and GlitchTip alike.
// It sends only what is needed to fix a bug and removes anything that could identify a person or a document.

export interface Dsn { key: string; protocol: string; host: string; path: string; projectId: string }

export function parseDsn(dsn: string | undefined): Dsn | null {
  if (!dsn) return null;
  try {
    const u = new URL(dsn);
    const parts = u.pathname.split('/').filter(Boolean);
    const projectId = parts.pop();
    if (!u.username || !projectId) return null;
    return { key: u.username, protocol: u.protocol.replace(':', ''), host: u.host, path: parts.length ? `/${parts.join('/')}` : '', projectId };
  } catch { return null; }
}

export const envelopeUrl = (d: Dsn) => `${d.protocol}://${d.host}${d.path}/api/${d.projectId}/envelope/?sentry_key=${d.key}&sentry_version=7`;

/** Removes emails, bearer tokens, Supabase keys and JWT-looking strings from text before it leaves the device or server. */
export function scrub(s: string): string {
  return s
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/Bearer\s+[\w.\-~+/=]+/gi, 'Bearer [token]')
    .replace(/sb_(secret|publishable)_[\w-]+/g, 'sb_$1_[key]')
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[jwt]')
    .replace(/([?&](?:token|key|apikey|access_token)=)[^&\s]+/gi, '$1[redacted]');
}

export interface EventInput { error: unknown; where: string; extra?: Record<string, string | number | boolean>; userId?: string }
export interface ReporterOptions {
  dsn?: string; environment?: string; release?: string; platform?: 'javascript' | 'node';
  fetchImpl?: typeof fetch; now?: () => number;
}

export function buildEnvelope(ev: EventInput, o: { dsn: Dsn; environment: string; release?: string; platform: string; now: number; eventId: string }): string {
  const err = ev.error instanceof Error ? ev.error : new Error(typeof ev.error === 'string' ? ev.error : 'Unknown error');
  const event = {
    event_id: o.eventId, timestamp: o.now / 1000, platform: o.platform, level: 'error', environment: o.environment, release: o.release,
    exception: { values: [{ type: err.name || 'Error', value: scrub(err.message).slice(0, 500) }] },
    tags: { where: ev.where },
    extra: { ...(ev.extra ?? {}), stack: scrub(err.stack ?? '').slice(0, 4000) },
    user: ev.userId ? { id: ev.userId } : undefined, // an id only, never an email
  };
  return [JSON.stringify({ event_id: o.eventId, sent_at: new Date(o.now).toISOString() }), JSON.stringify({ type: 'event' }), JSON.stringify(event)].join('\n');
}

export function createReporter(o: ReporterOptions) {
  const dsn = parseDsn(o.dsn);
  const now = o.now ?? Date.now;
  const seen = new Map<string, number>();
  let windowStart = 0, sent = 0;
  return {
    enabled: !!dsn,
    async capture(ev: EventInput): Promise<boolean> {
      if (!dsn) return false;
      const t = now();
      const sig = `${ev.where}:${ev.error instanceof Error ? ev.error.message : String(ev.error)}`;
      if (t - (seen.get(sig) ?? -Infinity) < 60_000) return false; // the same error at most once a minute
      if (t - windowStart > 60_000) { windowStart = t; sent = 0; }
      if (++sent > 30) return false;                                  // and never a flood
      seen.set(sig, t);
      if (seen.size > 200) seen.clear();
      const body = buildEnvelope(ev, { dsn, environment: o.environment ?? 'production', release: o.release, platform: o.platform ?? 'javascript', now: t, eventId: crypto.randomUUID().replace(/-/g, '') });
      try { await (o.fetchImpl ?? fetch)(envelopeUrl(dsn), { method: 'POST', body, keepalive: true }); return true; }
      catch { return false; } // reporting must never break the app
    },
  };
}
