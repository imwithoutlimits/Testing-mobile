import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export function isPrivateIp(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe8') || l.startsWith('fe9') || l.startsWith('fea') || l.startsWith('feb');
}

async function assertPublic(u: URL) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only web addresses (http or https) can be imported.');
  const addrs = isIP(u.hostname) ? [{ address: u.hostname }] : await lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('That address is not reachable from here.');
}

async function fetchHtml(start: URL): Promise<{ html: string; url: URL }> {
  let url = start;
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(url);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await fetch(url, { redirect: 'manual', signal: ctl.signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; earshelf-reader)', accept: 'text/html,application/xhtml+xml' } });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = new URL(res.headers.get('location')!, url); continue; }
      if (!res.ok) throw new Error(`The page returned ${res.status}.`);
      if (!/html|xml/i.test(res.headers.get('content-type') ?? '')) throw new Error('That link is not a web page.');
      const reader = res.body!.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 3_000_000) { await reader.cancel(); throw new Error('That page is too large to import.'); }
        chunks.push(value);
      }
      return { html: Buffer.concat(chunks).toString('utf8'), url };
    } finally { clearTimeout(t); }
  }
  throw new Error('That link redirects too many times.');
}

export async function fetchArticle(raw: string): Promise<{ title: string; byline: string | null; html: string }> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error('That does not look like a web address.'); }
  const { html, url } = await fetchHtml(u);
  const { parseHTML } = await import('linkedom');
  const { Readability } = await import('@mozilla/readability');
  const { document } = parseHTML(html);
  try { (document as unknown as { documentURI?: string }).documentURI = url.href; } catch { /* read-only in some builds */ }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parsed = new Readability(document as any).parse();
  if (!parsed?.content) throw new Error('We could not find the article text on that page. Try pasting it instead.');
  return { title: parsed.title || url.hostname, byline: parsed.byline ?? null, html: parsed.content };
}
