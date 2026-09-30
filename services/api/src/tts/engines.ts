import { config } from '../config.ts';
import { decodeToPcm } from './ffmpeg.ts';
import { bufferToPcm } from './pcm.ts';
import type { Pcm, TtsContext, TtsEngine, Voice } from './types.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Providers answer 429 (slow down) or 5xx (hiccup) now and then. Try again a couple of times before giving up. */
export async function withRetry(fn: () => Promise<Response>, wait: (ms: number) => Promise<void> = sleep, tries = 3): Promise<Response> {
  let last: Response | null = null;
  for (let i = 0; i < tries; i++) {
    const res = await fn();
    if (res.status !== 429 && res.status < 500) return res;
    last = res;
    if (i < tries - 1) await wait(500 * 2 ** i);
  }
  return last as Response;
}

/* ---------- any server that speaks the OpenAI /audio/speech format (OpenAI, Kokoro-FastAPI, self-hosted) ---------- */
export interface OpenAiLikeConfig {
  id: string; label: string; base: string; key?: string; model: string; format: 'pcm' | 'mp3' | 'wav';
  voices: string[]; discoverVoices?: boolean; sampleRate: number; commercialUseAllowed: boolean;
}

export function makeOpenAiLike(c: OpenAiLikeConfig, f: typeof fetch = fetch, wait?: (ms: number) => Promise<void>): TtsEngine {
  const asVoice = (id: string): Voice => ({ id, name: id, lang: 'en' });
  return {
    id: c.id, label: c.label, commercialUseAllowed: c.commercialUseAllowed, available: () => !!c.base,
    async listVoices() {
      if (c.discoverVoices) {
        try {
          const r = await f(`${c.base}/audio/voices`);
          if (r.ok) {
            const all = ((await r.json()) as { voices?: unknown }).voices;
            const ids = (Array.isArray(all) ? all : []).filter((v): v is string => typeof v === 'string');
            const english = ids.filter((v) => /^(af|am|bf|bm)_/.test(v));
            if (ids.length) return (english.length ? english : ids).map(asVoice);
          }
        } catch { /* fall back to the configured list */ }
      }
      return c.voices.map(asVoice);
    },
    async synthesize(text: string, voice: string): Promise<Pcm> {
      const res = await withRetry(() => f(`${c.base}/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(c.key ? { Authorization: `Bearer ${c.key}` } : {}) },
        body: JSON.stringify({ model: c.model, input: text, voice, response_format: c.format }),
      }), wait);
      if (!res.ok) throw new Error(`The voice server returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return { samples: c.format === 'pcm' ? bufferToPcm(buf) : await decodeToPcm(buf, c.sampleRate), sampleRate: c.sampleRate };
    },
  };
}

/* ---------- ElevenLabs ---------- */
export interface ElevenConfig { key: string; base: string; model: string; voiceIds: string[]; concurrency: number; stability: number }

export function makeElevenLabs(c: ElevenConfig, f: typeof fetch = fetch, wait?: (ms: number) => Promise<void>): TtsEngine {
  let cache: { at: number; voices: Voice[] } | null = null;
  const rate = 24000;
  return {
    id: 'elevenlabs', label: 'ElevenLabs (premium voices)', commercialUseAllowed: true, concurrency: c.concurrency, available: () => !!c.key,
    async listVoices() {
      if (cache && Date.now() - cache.at < 600_000) return cache.voices;
      const res = await f(`${c.base}/v1/voices`, { headers: { 'xi-api-key': c.key } });
      if (!res.ok) throw new Error(res.status === 401 ? 'ElevenLabs rejected the API key.' : `ElevenLabs returned ${res.status} while listing voices.`);
      const data = (await res.json()) as { voices?: Array<{ voice_id: string; name: string; labels?: Record<string, string> }> };
      let voices = (data.voices ?? []).map((v) => ({ id: v.voice_id, name: [v.name, v.labels?.accent, v.labels?.gender].filter(Boolean).join(', '), lang: v.labels?.language ?? 'en' }));
      if (c.voiceIds.length) voices = voices.filter((v) => c.voiceIds.includes(v.id));
      cache = { at: Date.now(), voices };
      return voices;
    },
    async synthesize(text: string, voice: string, ctx?: TtsContext): Promise<Pcm> {
      const res = await withRetry(() => f(`${c.base}/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=pcm_${rate}`, {
        method: 'POST',
        headers: { 'xi-api-key': c.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text, model_id: c.model,
          // Neighbouring sentences let the voice keep the same tone from one sentence to the next.
          ...(ctx?.previous ? { previous_text: ctx.previous.slice(-500) } : {}), ...(ctx?.next ? { next_text: ctx.next.slice(0, 500) } : {}),
          voice_settings: { stability: c.stability, similarity_boost: 0.75 },
        }),
      }), wait);
      if (!res.ok) {
        const why = res.status === 401 ? 'ElevenLabs rejected the API key.' : res.status === 429 ? 'ElevenLabs is busy or your plan limit was reached.' : `ElevenLabs returned ${res.status}.`;
        throw new Error(why);
      }
      return { samples: bufferToPcm(Buffer.from(await res.arrayBuffer())), sampleRate: rate };
    },
  };
}

/* ---------- Edge voices: personal use only ---------- */
const EDGE_VOICES: Voice[] = [
  { id: 'en-US-AndrewMultilingualNeural', name: 'Andrew (US, multilingual)', lang: 'en-US' },
  { id: 'en-US-AvaMultilingualNeural', name: 'Ava (US, multilingual)', lang: 'en-US' },
  { id: 'en-US-EmmaMultilingualNeural', name: 'Emma (US, multilingual)', lang: 'en-US' },
  { id: 'en-US-BrianMultilingualNeural', name: 'Brian (US, multilingual)', lang: 'en-US' },
  { id: 'en-GB-SoniaNeural', name: 'Sonia (UK)', lang: 'en-GB' },
  { id: 'en-GB-RyanNeural', name: 'Ryan (UK)', lang: 'en-GB' },
];

/** Personal use only. Microsoft's online voices are an unofficial route and the library is AGPL. */
const edge: TtsEngine = {
  id: 'edge', label: 'Edge voices (owner only)', commercialUseAllowed: false, available: () => config.tts.edgeEnabled,
  async listVoices() { return EDGE_VOICES; },
  async synthesize(text, voice): Promise<Pcm> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import('edge-tts-universal').catch(() => null);
    if (!mod?.EdgeTTS) throw new Error('The Edge voice library is not installed on the server.');
    const result = await new mod.EdgeTTS(text, voice).synthesize();
    const bytes = Buffer.from(await result.audio.arrayBuffer());
    return { samples: await decodeToPcm(bytes, config.tts.sampleRate), sampleRate: config.tts.sampleRate };
  },
};

const t = config.tts;
const kokoroBase = t.kokoroHostPort ? `http://${t.kokoroHostPort}/v1` : '';
const ALL: TtsEngine[] = [
  makeOpenAiLike({ id: 'kokoro', label: 'Kokoro (free open voices)', base: kokoroBase, model: 'kokoro', format: 'pcm', voices: ['af_heart', 'af_bella', 'af_nicole', 'am_michael', 'am_fenrir', 'bf_emma', 'bm_george'], discoverVoices: true, sampleRate: t.sampleRate, commercialUseAllowed: true }),
  makeElevenLabs(t.eleven),
  makeOpenAiLike({ id: 'openai-compatible', label: 'Natural voice (server)', base: t.openaiBase, key: t.openaiKey, model: t.openaiModel, format: t.openaiFormat, voices: t.openaiVoices, sampleRate: t.sampleRate, commercialUseAllowed: true }),
  edge,
];

export function enginesFor(userId: string): TtsEngine[] {
  return ALL.filter((e) => e.available() && (e.id !== 'edge' || config.tts.edgeUsers.has(userId)));
}
export function engineFor(id: string, userId: string): TtsEngine | null {
  return enginesFor(userId).find((e) => e.id === id) ?? null;
}
