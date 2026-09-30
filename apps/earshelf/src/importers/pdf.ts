import * as pdfjs from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Imported } from '../pipeline';
import { ImportError, NeedsOcrError } from './errors';
import { addOcrUsed } from './ocr';

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

interface Item { str: string; x: number; y: number; h: number }

function pageToText(items: Item[]): string {
  if (!items.length) return '';
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Array<{ y: number; h: number; parts: Item[] }> = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) < Math.max(2, it.h * 0.5)) last.parts.push(it);
    else lines.push({ y: it.y, h: it.h, parts: [it] });
  }
  const heights = lines.map((l) => l.h).sort((a, b) => a - b);
  const bodyH = heights[Math.floor(heights.length / 2)] || 10;
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) gaps.push(lines[i - 1].y - lines[i].y);
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const normalGap = sortedGaps[Math.floor(sortedGaps.length / 2)] || bodyH * 1.2;
  const out: string[] = [];
  lines.forEach((l, i) => {
    const text = l.parts.sort((a, b) => a.x - b.x).map((p) => p.str).join(' ').replace(/\s+/g, ' ').trim();
    if (!text) return;
    if (i > 0 && lines[i - 1].y - l.y > normalGap * 1.45) out.push('');
    if (l.h > bodyH * 1.25 && text.length < 90) out.push('', `# ${text}`, '');
    else out.push(text);
  });
  return out.join('\n');
}

export async function importPdf(file: File, onProgress?: (done: number, total: number) => void): Promise<Imported> {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data }).promise;
  const pages: string[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    const items: Item[] = [];
    for (const it of content.items) {
      if (!('str' in it) || !it.str.trim()) continue;
      items.push({ str: it.str, x: it.transform[4], y: it.transform[5], h: Math.abs(it.transform[3]) || it.height });
    }
    pages.push(pageToText(items));
    onProgress?.(n, pdf.numPages);
  }
  const chars = pages.reduce((n, p) => n + p.length, 0);
  if (chars < 40 * pdf.numPages) throw new NeedsOcrError();
  const info = (await pdf.getMetadata().catch(() => null))?.info as { Title?: string; Author?: string } | undefined;
  return {
    pages,
    meta: { title: info?.Title?.trim() || file.name.replace(/\.pdf$/i, ''), author: info?.Author?.trim() || undefined, sourceType: 'pdf', pageCount: pdf.numPages },
    fileName: file.name, mime: file.type || 'application/pdf', blob: file,
  };
}

/** Reads a scanned PDF by rendering each page and recognizing the text in the browser. */
export async function ocrPdf(file: File, onProgress: (done: number, total: number) => void, pagesLeft: number): Promise<Imported> {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  if (pdf.numPages > pagesLeft) throw new ImportError(`This PDF has ${pdf.numPages} pages but you have ${pagesLeft} scanned pages left this month.`);
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('eng');
  const pages: string[] = [];
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      onProgress(n - 1, pdf.numPages);
      const page = await pdf.getPage(n);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width; canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
      pages.push((await worker.recognize(canvas)).data.text);
    }
    onProgress(pdf.numPages, pdf.numPages);
  } finally { await worker.terminate(); }
  await addOcrUsed(pdf.numPages);
  return { pages, meta: { title: file.name.replace(/\.pdf$/i, ''), sourceType: 'pdf', pageCount: pdf.numPages }, fileName: file.name, mime: 'application/pdf', blob: file };
}
