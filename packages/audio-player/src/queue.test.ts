import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackQueue, SleepTimer, type Scheduler } from './queue.ts';
import type { Utterance } from '../../core/src/model.ts';

const u = (id: string, blockId: string, sectionId: string, words = 16, kind: Utterance['kind'] = 'paragraph'): Utterance => ({
  id, blockId, sectionId, kind, text: id, spoken: Array.from({ length: words }, () => 'w').join(' '), pauseAfterMs: 0,
});
const items = [
  u('h1', 'b1', 's1', 2, 'heading'), u('a', 'b2', 's1'), u('b', 'b2', 's1'),
  u('c', 'b3', 's1'), u('h2', 'b4', 's2', 2, 'heading'), u('d', 'b5', 's2'), u('e', 'b5', 's2'),
];

test('next/prev clamp at both ends', () => {
  const q = new PlaybackQueue(items, 0);
  assert.equal(q.prev(), false);
  q.setIndex(99);
  assert.equal(q.index, items.length - 1);
  assert.equal(q.next(), false);
});

test('paragraph navigation: replay, previous, next', () => {
  const q = new PlaybackQueue(items, 2); // sentence b, mid-paragraph b2
  assert.equal(q.paragraph(0), 1);
  q.setIndex(2);
  assert.equal(q.paragraph(-1), 1); // to start of current paragraph first
  assert.equal(q.paragraph(-1), 0); // then previous paragraph
  q.setIndex(1);
  assert.equal(q.paragraph(1), 3);
});

test('section navigation and heading skip', () => {
  const q = new PlaybackQueue(items, 1);
  assert.equal(q.section(1), 4);
  assert.equal(q.section(-1), 0);
  q.setIndex(0);
  assert.equal(q.skipHeading(), 1);
  assert.equal(q.skipHeading(), 1); // not on a heading: stays
});

test('time seeking moves about the requested seconds', () => {
  const q = new PlaybackQueue(Array.from({ length: 40 }, (_, i) => u(`x${i}`, `b${i}`, 's', 16)), 20);
  // 16 words at 160 wpm = 6s per utterance
  const back = q.seekSeconds(-15);
  assert.ok(back >= 16 && back <= 18, `back landed at ${back}`);
  q.setIndex(20);
  const fwd = q.seekSeconds(30);
  assert.ok(fwd >= 24 && fwd <= 26, `forward landed at ${fwd}`);
  q.setIndex(1);
  assert.equal(q.seekSeconds(-1000), 0);
});

test('sleep timer: minutes fires once, end-of-section fires on change, cancel prevents', () => {
  let fired = 0;
  const tasks: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const sched: Scheduler = {
    set: (fn, ms) => { const t = { fn, ms, live: true }; tasks.push(t); return t; },
    clear: (h) => { (h as { live: boolean }).live = false; },
  };
  let now = 0;
  const t = new SleepTimer(() => { fired++; }, sched, () => now);
  t.start({ kind: 'minutes', minutes: 10 });
  now = 4 * 60_000;
  assert.equal(t.remainingMs(), 6 * 60_000);
  tasks[0].fn();
  assert.equal(fired, 1);
  assert.equal(t.setting, null);
  t.start({ kind: 'end-of-section' });
  t.sectionChanged();
  assert.equal(fired, 2);
  t.start({ kind: 'minutes', minutes: 5 });
  t.cancel();
  assert.equal(tasks[tasks.length - 1].live, false);
});
