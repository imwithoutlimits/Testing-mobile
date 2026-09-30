import type { Utterance } from '../../../packages/core/src/model.ts';

export interface ChunkMeta { start: number; end: number; durationMs: number; items: Array<{ index: number; startMs: number }> }
export interface Chapter { startMs: number; endMs: number; title: string }

/** One chapter per section, positioned from the real audio timing. Very short sections join the chapter before them. */
export function buildChapters(utts: Utterance[], titles: Record<string, string>, metas: ChunkMeta[], docTitle: string, minMs = 15_000): Chapter[] {
  const offsets: number[] = [];
  let total = 0;
  for (const m of metas) { offsets.push(total); total += m.durationMs; }
  const starts: Array<{ startMs: number; title: string }> = [];
  const seen = new Set<string>();
  utts.forEach((u, i) => {
    if (seen.has(u.sectionId)) return;
    seen.add(u.sectionId);
    const ci = metas.findIndex((m) => i >= m.start && i <= m.end);
    const item = ci >= 0 ? metas[ci].items.find((x) => x.index === i) : undefined;
    if (ci >= 0 && item) starts.push({ startMs: offsets[ci] + item.startMs, title: titles[u.sectionId] || docTitle });
  });
  const raw: Chapter[] = starts.map((s, n) => ({ startMs: s.startMs, endMs: n + 1 < starts.length ? starts[n + 1].startMs : total, title: s.title }));
  const out: Chapter[] = [];
  for (const c of raw) {
    const prev = out[out.length - 1];
    if (prev && c.endMs - c.startMs < minMs) prev.endMs = c.endMs; else out.push({ ...c });
  }
  if (out.length) out[0].startMs = 0;
  return out.length ? out : [{ startMs: 0, endMs: total, title: docTitle }];
}

const esc = (s: string) => s.replace(/[=;#\\\n]/g, (c) => (c === '\n' ? ' ' : `\\${c}`));
/** ffmpeg's metadata file format, which carries chapter markers into MP3 and M4B files. */
export function ffmetadata(chapters: Chapter[], meta: { title: string; artist?: string }): string {
  const head = [';FFMETADATA1', `title=${esc(meta.title)}`, ...(meta.artist ? [`artist=${esc(meta.artist)}`] : [])];
  const body = chapters.flatMap((c) => ['[CHAPTER]', 'TIMEBASE=1/1000', `START=${Math.round(c.startMs)}`, `END=${Math.round(c.endMs)}`, `title=${esc(c.title)}`]);
  return [...head, ...body, ''].join('\n');
}

export interface ExportDeps {
  generate(chunkIndex: number): Promise<{ meta: ChunkMeta; mp3: Buffer }>;
  chunkCount: number;
  utterances: Utterance[];
  titles: Record<string, string>;
  docTitle: string;
  author?: string;
  format: 'mp3' | 'm4b';
  setJob(patch: { state?: string; progress?: number; error?: string; result?: Record<string, unknown> }): Promise<void>;
  packageAudio(mp3s: Buffer[], metadata: string, format: 'mp3' | 'm4b'): Promise<Buffer>;
  upload(buffer: Buffer, ext: string): Promise<string>;
}

/** Generates every part (parts already made are reused), stitches them with chapters, and stores the file. */
export async function runExport(d: ExportDeps): Promise<void> {
  try {
    const mp3s: Buffer[] = [];
    const metas: ChunkMeta[] = [];
    for (let ci = 0; ci < d.chunkCount; ci++) {
      await d.setJob({ state: 'generating', progress: (ci / d.chunkCount) * 0.9 });
      const r = await d.generate(ci);
      mp3s.push(r.mp3); metas.push(r.meta);
    }
    await d.setJob({ state: 'packaging', progress: 0.92 });
    const chapters = buildChapters(d.utterances, d.titles, metas, d.docTitle);
    const file = await d.packageAudio(mp3s, ffmetadata(chapters, { title: d.docTitle, artist: d.author }), d.format);
    const path = await d.upload(file, d.format);
    await d.setJob({ state: 'ready', progress: 1, result: { path, ext: d.format, bytes: file.length, durationMs: metas.reduce((n, m) => n + m.durationMs, 0), chapters: chapters.length } });
  } catch (e) {
    await d.setJob({ state: 'failed', error: e instanceof Error ? e.message : 'The export failed.' }).catch(() => {});
  }
}
