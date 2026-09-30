import type { Utterance } from '../../core/src/model.ts';
import type { AudioChunk } from './tts.ts';

export type EngineEvent =
  | { type: 'utterance'; index: number }
  | { type: 'ended' }
  | { type: 'gap'; index: number }
  | { type: 'error'; message: string };

export interface PlaybackEngine {
  readonly kind: 'speech' | 'audio';
  load(items: Utterance[]): void;
  play(from: number): void;
  pause(): void;
  stop(): void;
  setRate(r: number): void;
  setVolume(v: number): void;
  setVoice(id: string | null): void;
  on(cb: (e: EngineEvent) => void): void;
}

/** Sentence-by-sentence browser speech. Short utterances avoid Chrome's long-utterance cutoff. */
export class SpeechEngine implements PlaybackEngine {
  readonly kind = 'speech' as const;
  private items: Utterance[] = [];
  private cb: (e: EngineEvent) => void = () => {};
  private rate = 1;
  private volume = 1;
  private voiceURI: string | null = null;
  private token = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lang = 'en';

  static supported(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
  }
  constructor(lang = 'en') { this.lang = lang; }
  on(cb: (e: EngineEvent) => void) { this.cb = cb; }
  load(items: Utterance[]) { this.stop(); this.items = items; }
  setRate(r: number) { this.rate = r; }
  setVolume(v: number) { this.volume = v; }
  setVoice(id: string | null) { this.voiceURI = id; }

  play(from: number) {
    this.stop();
    const my = ++this.token;
    const speakAt = (i: number) => {
      if (my !== this.token) return;
      if (i >= this.items.length) { this.cb({ type: 'ended' }); return; }
      const u = this.items[i];
      this.cb({ type: 'utterance', index: i });
      const ut = new SpeechSynthesisUtterance(u.spoken);
      ut.rate = this.rate;
      ut.volume = this.volume;
      ut.lang = this.lang;
      const v = this.voiceURI ? speechSynthesis.getVoices().find((x) => x.voiceURI === this.voiceURI) : undefined;
      if (v) { ut.voice = v; ut.lang = v.lang; }
      ut.onend = () => {
        if (my !== this.token) return;
        this.timer = setTimeout(() => speakAt(i + 1), u.pauseAfterMs / this.rate);
      };
      ut.onerror = (ev) => {
        if (my !== this.token) return;
        if (ev.error === 'interrupted' || ev.error === 'canceled') return;
        this.cb({ type: 'error', message: `Your device voice stopped (${ev.error}). Press play to continue.` });
      };
      speechSynthesis.speak(ut);
    };
    speakAt(from);
  }
  /** Pause = cancel and remember position; pause()/resume() are unreliable across mobile browsers. */
  pause() { this.stop(); }
  stop() {
    this.token++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (SpeechEngine.supported()) speechSynthesis.cancel();
  }
}

/** Plays server-generated audio chunks with an <audio> element; survives screen lock and app switching. */
export class AudioChunkEngine implements PlaybackEngine {
  readonly kind = 'audio' as const;
  private el: HTMLAudioElement;
  private chunks: AudioChunk[] = [];
  private items: Utterance[] = [];
  private cb: (e: EngineEvent) => void = () => {};
  private currentUrl = '';
  private lastIndex = -1;

  constructor(el?: HTMLAudioElement) {
    this.el = el ?? new Audio();
    this.el.preload = 'auto';
    this.el.addEventListener('timeupdate', () => this.track());
    this.el.addEventListener('ended', () => this.nextChunk());
    this.el.addEventListener('error', () => this.cb({ type: 'error', message: 'This audio could not be loaded. Check your connection, or switch to the device voice.' }));
  }
  on(cb: (e: EngineEvent) => void) { this.cb = cb; }
  load(items: Utterance[]) { this.items = items; }
  /** Chunks may arrive in any order; they are kept sorted by the first utterance they cover. */
  setChunks(chunks: AudioChunk[]) { this.chunks = [...chunks].sort((a, b) => (a.items[0]?.index ?? 0) - (b.items[0]?.index ?? 0)); }
  setRate(r: number) { this.el.playbackRate = r; }
  setVolume(v: number) { this.el.volume = v; }
  setVoice() {}

  private chunkFor(index: number): AudioChunk | undefined {
    return this.chunks.find((c) => {
      const first = c.items[0]?.index ?? Infinity, last = c.items[c.items.length - 1]?.index ?? -1;
      return index >= first && index <= last;
    });
  }
  /** True when audio exists for this utterance; otherwise the controller falls back to browser speech. */
  covers(index: number) { return !!this.chunkFor(index); }

  play(from: number) {
    const c = this.chunkFor(from);
    if (!c) { this.cb({ type: 'gap', index: from }); return; }
    const startMs = c.items.find((it) => it.index === from)?.startMs ?? 0;
    const start = () => { this.el.currentTime = startMs / 1000; void this.el.play().catch(() => this.cb({ type: 'error', message: 'Playback was blocked. Tap play again.' })); };
    if (this.currentUrl !== c.url) {
      this.currentUrl = c.url;
      this.el.src = c.url;
      this.el.addEventListener('loadedmetadata', start, { once: true });
      this.el.load();
    } else start();
    this.lastIndex = -1;
  }
  private track() {
    const chunk = this.chunks.find((c) => c.url === this.currentUrl);
    if (!chunk) return;
    const t = this.el.currentTime * 1000;
    let idx = chunk.items[0]?.index ?? 0;
    for (const it of chunk.items) { if (it.startMs <= t) idx = it.index; else break; }
    if (idx !== this.lastIndex) { this.lastIndex = idx; this.cb({ type: 'utterance', index: idx }); }
  }
  private nextChunk() {
    const chunk = this.chunks.find((c) => c.url === this.currentUrl);
    const last = chunk?.items[chunk.items.length - 1]?.index ?? -1;
    if (last >= this.items.length - 1) { this.cb({ type: 'ended' }); return; }
    if (this.covers(last + 1)) this.play(last + 1);
    else this.cb({ type: 'gap', index: last + 1 }); // the controller fetches it and continues
  }
  pause() { this.el.pause(); }
  stop() { this.el.pause(); this.lastIndex = -1; }
}
