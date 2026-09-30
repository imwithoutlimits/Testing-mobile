import JSZip from 'jszip';
import { htmlToText } from './html';
import type { Imported } from '../pipeline';

const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
const resolve = (base: string, href: string) => {
  const parts = (base + decodeURIComponent(href.split('#')[0])).split('/');
  const out: string[] = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
  return out.join('/');
};

export async function importEpub(file: File): Promise<Imported> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const read = async (path: string) => {
    const f = zip.file(path);
    if (!f) throw new Error(`This EPUB is missing a required file (${path}). Try re-exporting it.`);
    return f.async('string');
  };
  const parser = new DOMParser();
  const container = parser.parseFromString(await read('META-INF/container.xml'), 'application/xml');
  const opfPath = container.querySelector('rootfile')?.getAttribute('full-path');
  if (!opfPath) throw new Error('This EPUB has no package file, so it cannot be read.');
  const opf = parser.parseFromString(await read(opfPath), 'application/xml');
  const base = dirname(opfPath);
  const manifest = new Map<string, { href: string; type: string }>();
  opf.querySelectorAll('manifest > item').forEach((it) => manifest.set(it.getAttribute('id') ?? '', { href: it.getAttribute('href') ?? '', type: it.getAttribute('media-type') ?? '' }));
  const spine = Array.from(opf.querySelectorAll('spine > itemref')).map((r) => manifest.get(r.getAttribute('idref') ?? '')).filter((m): m is { href: string; type: string } => !!m && /x?html/.test(m.type));
  if (!spine.length) throw new Error('This EPUB has no readable chapters.');

  const chapters: string[] = [];
  for (const item of spine) {
    const html = await read(resolve(base, item.href));
    const doc = parser.parseFromString(html, 'application/xhtml+xml');
    const body = doc.querySelector('body') ?? parser.parseFromString(html, 'text/html').body;
    const text = htmlToText(body);
    if (text.trim().length > 20) chapters.push(text);
  }
  const title = opf.querySelector('metadata > title, metadata title')?.textContent?.trim();
  const author = opf.querySelector('metadata > creator, metadata creator')?.textContent?.trim();
  const language = opf.querySelector('metadata > language, metadata language')?.textContent?.trim();
  return {
    pages: [chapters.join('\n\n')],
    meta: { title: title || file.name.replace(/\.epub$/i, ''), author, language, sourceType: 'epub' },
    fileName: file.name, mime: 'application/epub+zip', blob: file,
  };
}
