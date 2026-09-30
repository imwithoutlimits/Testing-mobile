import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function ffmpeg(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd });
    let err = '';
    p.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    p.on('error', (e: Error) => reject(new Error(`ffmpeg is not available: ${e.message}`)));
    p.on('close', (code: number) => (code === 0 ? resolve() : reject(new Error(`Packaging failed: ${err.slice(0, 300)}`))));
  });
}

/** Joins the MP3 parts into one audiobook file with chapter markers. M4B is re-encoded because that container needs AAC. */
export async function packageAudio(parts: Buffer[], metadata: string, format: 'mp3' | 'm4b'): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'earshelf-'));
  try {
    for (let i = 0; i < parts.length; i++) await writeFile(join(dir, `p${String(i).padStart(4, '0')}.mp3`), parts[i]);
    await writeFile(join(dir, 'list.txt'), parts.map((_, i) => `file 'p${String(i).padStart(4, '0')}.mp3'`).join('\n'));
    await writeFile(join(dir, 'meta.txt'), metadata);
    const out = `out.${format}`;
    const codec = format === 'm4b' ? ['-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', '-f', 'ipod'] : ['-c:a', 'copy', '-id3v2_version', '3'];
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-i', 'meta.txt', '-map', '0:a', '-map_metadata', '1', ...codec, out], dir);
    return await readFile(join(dir, out));
  } finally { await rm(dir, { recursive: true, force: true }); }
}
