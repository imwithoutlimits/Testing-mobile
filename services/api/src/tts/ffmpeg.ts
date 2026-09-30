import { spawn } from 'node:child_process';
import { bufferToPcm } from './pcm.ts';

function run(args: string[], input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args]);
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d: Buffer) => out.push(d));
    p.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    p.on('error', (e) => reject(new Error(`ffmpeg is not available: ${e.message}`)));
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg failed: ${err.slice(0, 300)}`))));
    p.stdin.on('error', () => { /* ffmpeg exited early; the close handler reports it */ });
    p.stdin.end(input);
  });
}

export async function pcmToMp3(samples: Int16Array, rate: number): Promise<Buffer> {
  const raw = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  return run(['-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', 'pipe:0', '-codec:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3', 'pipe:1'], raw);
}

export async function decodeToPcm(bytes: Buffer, rate: number): Promise<Int16Array> {
  return bufferToPcm(await run(['-i', 'pipe:0', '-f', 's16le', '-ar', String(rate), '-ac', '1', 'pipe:1'], bytes));
}
