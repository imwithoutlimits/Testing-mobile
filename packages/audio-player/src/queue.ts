import type { Utterance } from '../../core/src/model.ts';

const WORDS_PER_SECOND = 160 / 60;

export function utteranceSeconds(u: Utterance, rate = 1): number {
  const words = u.spoken.split(/\s+/).filter(Boolean).length;
  return words / (WORDS_PER_SECOND * rate) + u.pauseAfterMs / 1000;
}

export class PlaybackQueue {
  private i = 0;
  readonly items: Utterance[];
  constructor(items: Utterance[], start = 0) {
    this.items = items;
    this.setIndex(start);
  }
  get length() { return this.items.length; }
  get index() { return this.i; }
  get current(): Utterance | undefined { return this.items[this.i]; }
  get atEnd() { return this.i >= this.items.length - 1; }

  setIndex(n: number) {
    this.i = this.items.length ? Math.min(Math.max(0, Math.floor(n)), this.items.length - 1) : 0;
    return this.i;
  }
  next(): boolean {
    if (this.atEnd) return false;
    this.i++;
    return true;
  }
  prev(): boolean {
    if (this.i === 0) return false;
    this.i--;
    return true;
  }

  private blockStart(from: number): number {
    const id = this.items[from]?.blockId;
    let k = from;
    while (k > 0 && this.items[k - 1].blockId === id) k--;
    return k;
  }
  /** offset 0 = replay this paragraph, -1 = previous paragraph, +1 = next paragraph. */
  paragraph(offset: -1 | 0 | 1): number {
    if (!this.items.length) return 0;
    const start = this.blockStart(this.i);
    if (offset === 0) return this.setIndex(start);
    if (offset === -1) {
      if (this.i > start) return this.setIndex(start);
      return this.setIndex(start > 0 ? this.blockStart(start - 1) : 0);
    }
    let k = this.i;
    while (k < this.items.length - 1 && this.items[k].blockId === this.items[this.i].blockId) k++;
    return this.setIndex(k);
  }
  section(offset: -1 | 1): number {
    if (!this.items.length) return 0;
    const sid = this.items[this.i].sectionId;
    if (offset === 1) {
      const k = this.items.findIndex((u, n) => n > this.i && u.sectionId !== sid);
      return this.setIndex(k === -1 ? this.items.length - 1 : k);
    }
    let start = this.i;
    while (start > 0 && this.items[start - 1].sectionId === sid) start--;
    if (this.i > start) return this.setIndex(start);
    if (start === 0) return this.setIndex(0);
    const prevSid = this.items[start - 1].sectionId;
    let k = start - 1;
    while (k > 0 && this.items[k - 1].sectionId === prevSid) k--;
    return this.setIndex(k);
  }
  /** Jump past the heading at the current position. */
  skipHeading(): number {
    const cur = this.current;
    if (cur?.kind === 'heading') return this.setIndex(this.i + 1);
    return this.i;
  }
  /** Approximate time-based seeking: walks utterances until the requested seconds are covered. */
  seekSeconds(seconds: number, rate = 1): number {
    let remaining = Math.abs(seconds);
    let k = this.i;
    const dir = seconds < 0 ? -1 : 1;
    while (remaining > 0) {
      const n = k + dir;
      if (n < 0 || n >= this.items.length) break;
      k = n;
      remaining -= utteranceSeconds(this.items[dir === 1 ? k - 1 : k], rate);
    }
    return this.setIndex(k);
  }
  remainingSeconds(rate = 1): number {
    return this.items.slice(this.i).reduce((s, u) => s + utteranceSeconds(u, rate), 0);
  }
  totalSeconds(rate = 1): number {
    return this.items.reduce((s, u) => s + utteranceSeconds(u, rate), 0);
  }
}

export interface Scheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
const realScheduler: Scheduler = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

export type SleepSetting = { kind: 'minutes'; minutes: number } | { kind: 'end-of-section' };

export class SleepTimer {
  private handle: unknown = null;
  private endsAt: number | null = null;
  setting: SleepSetting | null = null;
  private onFire: () => void;
  private sched: Scheduler;
  private now: () => number;
  constructor(onFire: () => void, sched: Scheduler = realScheduler, now: () => number = Date.now) {
    this.onFire = onFire;
    this.sched = sched;
    this.now = now;
  }
  start(s: SleepSetting) {
    this.cancel();
    this.setting = s;
    if (s.kind === 'minutes') {
      this.endsAt = this.now() + s.minutes * 60_000;
      this.handle = this.sched.set(() => this.fire(), s.minutes * 60_000);
    }
  }
  /** Call whenever the section changes; fires an 'end-of-section' timer. */
  sectionChanged() {
    if (this.setting?.kind === 'end-of-section') this.fire();
  }
  private fire() {
    this.cancel();
    this.onFire();
  }
  cancel() {
    if (this.handle !== null) this.sched.clear(this.handle);
    this.handle = null;
    this.endsAt = null;
    this.setting = null;
  }
  remainingMs(): number | null {
    return this.endsAt === null ? null : Math.max(0, this.endsAt - this.now());
  }
}
