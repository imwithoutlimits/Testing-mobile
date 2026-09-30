import test from 'node:test';
import assert from 'node:assert/strict';
import { stitch, toWav, silence } from './pcm.ts';
import { mapPool, renderChunk } from './render.ts';
import type { TtsEngine } from './types.ts';
import type { Utterance } from '../../../../packages/core/src/model.ts';

const RATE = 24000;
const fake: TtsEngine = {
  id: 'fake', label: 'Fake', commercialUseAllowed: true, available: () => true, listVoices: async () => [],
  synthesize: async (text) => {
    await new Promise((r) => setTimeout(r, Math.random() * 5)); // out-of-order completion
    return { samples: new Int16Array(Math.round(RATE * 0.01 * text.length)).fill(1000), sampleRate: RATE };
  },
};
const u = (i: number, spoken: string, pauseAfterMs: number): Utterance => ({ id: `u${i}`, blockId: 'b', sectionId: 's', kind: 'paragraph', text: spoken, spoken, pauseAfterMs });

test('stitch: offsets are exact and pauses are silent', () => {
  const a = new Int16Array(RATE).fill(5); // 1 s
  const b = new Int16Array(RATE / 2).fill(7); // 0.5 s
  const s = stitch([{ samples: a, pauseAfterMs: 500 }, { samples: b, pauseAfterMs: 250 }], RATE);
  assert.deepEqual(s.startMs, [0, 1500]);
  assert.equal(s.durationMs, 2250);
  assert.equal(s.samples[RATE + 100], 0); // inside the 0.5 s pause
  assert.equal(s.samples[RATE * 1.5 + 10], 7);
  assert.equal(silence(1000, RATE).length, RATE);
});

test('wav header describes the audio', () => {
  const w = toWav(new Int16Array(100), RATE);
  assert.equal(w.toString('ascii', 0, 4), 'RIFF');
  assert.equal(w.readUInt32LE(24), RATE);
  assert.equal(w.readUInt32LE(40), 200);
});

test('mapPool keeps order and honours the concurrency limit', async () => {
  let running = 0, peak = 0;
  const out = await mapPool([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 5)); running--; return n * 2; });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14, 16]);
  assert.ok(peak <= 3);
});

test('renderChunk: indices continue from the chunk start and timings follow the audio', async () => {
  const utts = [u(0, 'a'.repeat(100), 200), u(1, 'b'.repeat(50), 0), u(2, 'c'.repeat(100), 400)]; // 1.0 s, 0.5 s, 1.0 s
  const r = await renderChunk(utts, 40, fake, 'v', 2);
  assert.deepEqual(r.items, [{ index: 40, startMs: 0 }, { index: 41, startMs: 1200 }, { index: 42, startMs: 1700 }]);
  assert.equal(r.durationMs, 3100);
});

import { makeElevenLabs, makeOpenAiLike, withRetry } from './engines.ts';

const pcmBytes = (n: number) => { const b = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) b.writeInt16LE(i % 100, i * 2); return b; };
const noWait = async () => {};

test('renderChunk passes neighbouring sentences and uses the engine concurrency', async () => {
  const seen: Array<[string, string | undefined, string | undefined]> = [];
  let running = 0, peak = 0;
  const eng: TtsEngine = { ...fake, concurrency: 1, synthesize: async (text, _v, ctx) => { running++; peak = Math.max(peak, running); seen.push([text, ctx?.previous, ctx?.next]); await new Promise((r) => setTimeout(r, 3)); running--; return { samples: new Int16Array(240), sampleRate: RATE }; } };
  await renderChunk([u(0, 'one', 0), u(1, 'two', 0), u(2, 'three', 0)], 0, eng, 'v');
  assert.deepEqual(seen.sort(), [['one', undefined, 'two'], ['three', 'two', undefined], ['two', 'one', 'three']]);
  assert.equal(peak, 1);
});

test('withRetry retries 429 and 5xx, not client errors', async () => {
  let n = 0;
  const res = await withRetry(async () => new Response('x', { status: ++n < 3 ? 429 : 200 }), noWait);
  assert.equal(res.status, 200); assert.equal(n, 3);
  let m = 0;
  assert.equal((await withRetry(async () => { m++; return new Response('no', { status: 400 }); }, noWait)).status, 400);
  assert.equal(m, 1);
  let k = 0;
  assert.equal((await withRetry(async () => { k++; return new Response('down', { status: 503 }); }, noWait)).status, 503);
  assert.equal(k, 3);
});

test('ElevenLabs: request shape, context, PCM decode, voice filtering, friendly errors', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.includes('/v1/voices')) return new Response(JSON.stringify({ voices: [{ voice_id: 'v1', name: 'Rachel', labels: { accent: 'american', gender: 'female' } }, { voice_id: 'v2', name: 'Other' }] }));
    return new Response(pcmBytes(480));
  }) as unknown as typeof fetch;
  const cfg = { key: 'k', base: 'https://api.elevenlabs.io', model: 'eleven_multilingual_v2', voiceIds: ['v1'], concurrency: 2, stability: 0.5 };
  const e = makeElevenLabs(cfg, f, noWait);
  assert.equal(e.available(), true); assert.equal(e.concurrency, 2);
  assert.deepEqual((await e.listVoices()).map((v) => v.id), ['v1']);
  const out = await e.synthesize('Hello there.', 'v1', { previous: 'Before.', next: 'After.' });
  assert.equal(out.samples.length, 480); assert.equal(out.sampleRate, 24000);
  const call = calls[calls.length - 1];
  assert.ok(call.url.endsWith('/v1/text-to-speech/v1?output_format=pcm_24000'));
  assert.equal((call.init.headers as Record<string, string>)['xi-api-key'], 'k');
  const body = JSON.parse(call.init.body as string);
  assert.equal(body.model_id, 'eleven_multilingual_v2'); assert.equal(body.previous_text, 'Before.'); assert.equal(body.next_text, 'After.');
  assert.equal(makeElevenLabs({ ...cfg, key: '' }, f).available(), false);
  const bad = makeElevenLabs(cfg, (async () => new Response('no', { status: 401 })) as unknown as typeof fetch, noWait);
  await assert.rejects(bad.synthesize('x', 'v1'), /rejected the API key/);
});

test('OpenAI-style engine: pcm request, Kokoro voice discovery with fallback', async () => {
  let body: Record<string, unknown> = {};
  const f = (async (url: string, init: RequestInit) => {
    if (url.endsWith('/audio/voices')) return new Response(JSON.stringify({ voices: ['af_heart', 'jf_alpha', 'bm_george'] }));
    body = JSON.parse(init.body as string);
    return new Response(pcmBytes(100));
  }) as unknown as typeof fetch;
  const cfg = { id: 'kokoro', label: 'Kokoro', base: 'http://kokoro-tts:8880/v1', model: 'kokoro', format: 'pcm' as const, voices: ['af_heart'], discoverVoices: true, sampleRate: 24000, commercialUseAllowed: true };
  const e = makeOpenAiLike(cfg, f, noWait);
  assert.deepEqual((await e.listVoices()).map((v) => v.id), ['af_heart', 'bm_george']); // English voices only
  assert.equal((await e.synthesize('Hi', 'af_heart')).samples.length, 100);
  assert.deepEqual([body.model, body.voice, body.response_format, body.input], ['kokoro', 'af_heart', 'pcm', 'Hi']);
  const offline = makeOpenAiLike(cfg, (async () => { throw new Error('down'); }) as unknown as typeof fetch);
  assert.deepEqual((await offline.listVoices()).map((v) => v.id), ['af_heart']);
  assert.equal(makeOpenAiLike({ ...cfg, base: '' }).available(), false);
});
