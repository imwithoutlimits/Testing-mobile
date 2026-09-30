import { htmlToText, articleRoot } from './html';
import type { Imported } from '../pipeline';
import { ImportError, NeedsOcrError } from './errors';

export { ImportError };
export interface ImportOpts { ocr: boolean; ocrPagesLeft: number }

export const ACCEPT = '.pdf,.epub,.md,.markdown,.txt,.docx,.html,.htm,.png,.jpg,.jpeg,.webp';
export const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;


const stem = (name: string) => name.replace(/\.[^.]+$/, '');
const parseHtml = (html: string) => new DOMParser().parseFromString(html, 'text/html');

export async function importFile(file: File, onProgress?: (done: number, total: number) => void, opts: ImportOpts = { ocr: false, ocrPagesLeft: 0 }): Promise<Imported> {
  const name = file.name.toLowerCase();
  if (IMAGE_EXT.test(name)) {
    if (!opts.ocr) throw new ImportError('Reading text from images needs OCR, which is included with Plus.');
    if (opts.ocrPagesLeft < 1) throw new ImportError('You have used all of this month\'s scanned pages.');
    return (await import('./ocr')).ocrImage(file, onProgress);
  }
  if (name.endsWith('.pdf')) {
    const pdf = await import('./pdf');
    try { return await pdf.importPdf(file, onProgress); }
    catch (e) {
      if (!(e instanceof NeedsOcrError) || !opts.ocr) throw e;
      return pdf.ocrPdf(file, onProgress ?? (() => {}), opts.ocrPagesLeft);
    }
  }
  if (name.endsWith('.epub')) return (await import('./epub')).importEpub(file);
  if (name.endsWith('.docx')) {
    const mammoth = (await import('mammoth/mammoth.browser')).default;
    const { value } = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
    const text = htmlToText(parseHtml(value).body);
    if (!text.trim()) throw new ImportError('This Word file has no readable text.');
    return { pages: [text], meta: { title: stem(file.name), sourceType: 'docx' }, fileName: file.name, mime: file.type, blob: file };
  }
  if (name.endsWith('.html') || name.endsWith('.htm')) {
    const doc = parseHtml(await file.text());
    return { pages: [htmlToText(articleRoot(doc))], meta: { title: doc.title?.trim() || stem(file.name), sourceType: 'html' }, fileName: file.name, mime: 'text/html', blob: file };
  }
  if (name.endsWith('.md') || name.endsWith('.markdown') || name.endsWith('.txt')) {
    const text = await file.text();
    if (!text.trim()) throw new ImportError('This file is empty.');
    return { pages: [text], meta: { title: stem(file.name), sourceType: name.endsWith('.txt') ? 'txt' : 'md' }, fileName: file.name, mime: file.type || 'text/plain', blob: file };
  }
  throw new ImportError(`We can't read ${file.name} yet. Supported: PDF, EPUB, DOCX, Markdown, text and HTML.`);
}

export function importPaste(text: string, title?: string): Imported {
  const trimmed = text.trim();
  if (!trimmed) throw new ImportError('Paste some text first.');
  const isHtml = /<\/?(p|div|h[1-6]|ul|ol|li|article|body)\b/i.test(trimmed);
  const body = isHtml ? htmlToText(articleRoot(parseHtml(trimmed))) : trimmed;
  return { pages: [body], meta: { title, sourceType: 'paste' }, fileName: `${title || 'Pasted text'}.txt`, mime: 'text/plain' };
}

/** Browsers cannot fetch other sites (CORS), so links go through the earshelf server. */
export async function importUrl(url: string): Promise<Imported> {
  const { apiGet, ApiError } = await import('../supabase');
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new ImportError('That does not look like a web address. Include https://.'); }
  try {
    const data = await apiGet<{ title?: string; byline?: string | null; html: string }>(`/v1/article?url=${encodeURIComponent(parsed.href)}`);
    const doc = parseHtml(data.html);
    return { pages: [htmlToText(articleRoot(doc))], meta: { title: data.title, author: data.byline ?? undefined, sourceType: 'url' }, fileName: `${data.title ?? parsed.hostname}.html`, mime: 'text/html' };
  } catch (e) {
    if (e instanceof ApiError) throw new ImportError(e.code === 'no_api' || e.code === 'unauthorized' ? 'Importing from a link needs you to be signed in and connected to the earshelf server. You can paste the article text instead.' : e.message);
    throw e;
  }
}
