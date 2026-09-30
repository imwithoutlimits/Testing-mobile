import type { Imported } from '../pipeline';
import { getSetting, setSetting } from '../db';

const monthKey = () => `usage:ocr:${new Date().toISOString().slice(0, 7)}`;
/** Pages read this month on this device. OCR runs in the browser, so this limit is a courtesy, not enforcement. */
export const ocrUsed = () => getSetting<number>(monthKey(), 0);
export const addOcrUsed = async (n: number) => setSetting(monthKey(), (await ocrUsed()) + n);

export async function ocrImage(file: File, onProgress?: (done: number, total: number) => void): Promise<Imported> {
  const { createWorker } = await import('tesseract.js');
  onProgress?.(0, 1);
  const worker = await createWorker('eng');
  try {
    const { data } = await worker.recognize(file);
    onProgress?.(1, 1);
    if (data.text.trim().length < 10) throw new Error('No readable text was found in that image. Try a sharper, well-lit photo.');
    await addOcrUsed(1);
    return { pages: [data.text], meta: { title: file.name.replace(/\.[^.]+$/, ''), sourceType: 'image' }, fileName: file.name, mime: file.type, blob: file };
  } finally { await worker.terminate(); }
}
