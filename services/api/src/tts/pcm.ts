export function silence(ms: number, rate: number): Int16Array {
  return new Int16Array(Math.max(0, Math.round((ms / 1000) * rate)));
}

export interface StitchPart { samples: Int16Array; pauseAfterMs: number }

/** Joins clips with exact silence between them. Offsets are sample-accurate, so highlighting stays in sync. */
export function stitch(parts: StitchPart[], rate: number): { samples: Int16Array; startMs: number[]; durationMs: number } {
  const gaps = parts.map((p) => silence(p.pauseAfterMs, rate).length);
  const total = parts.reduce((n, p, i) => n + p.samples.length + gaps[i], 0);
  const out = new Int16Array(total);
  const startMs: number[] = [];
  let at = 0;
  parts.forEach((p, i) => {
    startMs.push(Math.round((at / rate) * 1000));
    out.set(p.samples, at);
    at += p.samples.length + gaps[i];
  });
  return { samples: out, startMs, durationMs: Math.round((total / rate) * 1000) };
}

export function toWav(samples: Int16Array, rate: number): Buffer {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

export function bufferToPcm(buf: Buffer): Int16Array {
  const even = buf.length - (buf.length % 2);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + even);
  return new Int16Array(ab);
}
