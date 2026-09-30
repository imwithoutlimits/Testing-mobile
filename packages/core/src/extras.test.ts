import test from 'node:test';
import assert from 'node:assert/strict';
import { NEW_CARD_STATE, isDue, isWeak, pickDue, previewInterval, schedule, type SrsState } from './srs.ts';
import { pickWellStyle } from './wellVoice.ts';
import { buildEnvelope, createReporter, envelopeUrl, parseDsn, scrub } from './monitor.ts';

const T0 = 1_700_000_000_000, DAY = 86_400_000;

test('srs: a card climbs 1, 6, then multiplies by ease; again resets', () => {
  let s = NEW_CARD_STATE(T0);
  s = schedule(s, 'good', T0); assert.equal(s.intervalDays, 1); assert.equal(s.dueAt, T0 + DAY);
  s = schedule(s, 'good', T0 + DAY); assert.equal(s.intervalDays, 6);
  s = schedule(s, 'good', T0 + 7 * DAY); assert.equal(s.intervalDays, 15); // 6 * 2.5
  const lapsed = schedule(s, 'again', T0 + 30 * DAY);
  assert.equal(lapsed.reps, 0); assert.equal(lapsed.lapses, 1); assert.ok(lapsed.ease < s.ease);
  assert.equal(lapsed.dueAt, T0 + 30 * DAY + 10 * 60_000);
});

test('srs: ease never drops below 1.3, easy grows ease, intervals always move forward', () => {
  let s: SrsState = { ease: 1.35, intervalDays: 10, reps: 5, lapses: 0, dueAt: T0 };
  for (let i = 0; i < 5; i++) s = schedule(s, 'hard', T0);
  assert.equal(s.ease, 1.3);
  const easy = schedule({ ease: 2.5, intervalDays: 4, reps: 3, lapses: 0, dueAt: T0 }, 'easy', T0);
  assert.ok(easy.ease > 2.5 && easy.intervalDays > 4);
  const before = { ease: 1.3, intervalDays: 2, reps: 4, lapses: 0, dueAt: T0 };
  assert.ok(schedule(before, 'good', T0).intervalDays >= 3);
  assert.deepEqual(before, { ease: 1.3, intervalDays: 2, reps: 4, lapses: 0, dueAt: T0 }); // not mutated
});

test('srs: due filter, ordering, limit, weak cards, button previews', () => {
  const mk = (id: string, dueAt: number, lapses = 0, ease = 2.5) => ({ id, ease, intervalDays: 3, reps: 2, lapses, dueAt });
  const cards = [mk('late', T0 - 5 * DAY), mk('soon', T0 - DAY), mk('future', T0 + DAY), mk('weak', T0 - 2 * DAY, 3)];
  assert.deepEqual(pickDue(cards, T0).map((c) => c.id), ['late', 'weak', 'soon']);
  assert.deepEqual(pickDue(cards, T0, 1).map((c) => c.id), ['late']);
  assert.deepEqual(pickDue(cards, T0, 20, true).map((c) => c.id), ['weak']);
  assert.equal(isDue(cards[2], T0), false);
  assert.equal(isWeak(mk('x', T0, 0, 1.5)), true);
  assert.equal(previewInterval(NEW_CARD_STATE(T0), 'again', T0), '10 min');
  assert.equal(previewInterval(NEW_CARD_STATE(T0), 'good', T0), '1 day');
});

test('well voice: oldest styled well wins, unknown styles ignored', () => {
  const profiles = [{ id: 'bedtime', rate: 0.85, pause: 1.5 }, { id: 'energetic', rate: 1.2, pause: 0.8 }];
  const wells = [{ id: 'b', voiceProfile: 'energetic', createdAt: 200 }, { id: 'a', voiceProfile: 'bedtime', createdAt: 100 }, { id: 'c', createdAt: 50 }, { id: 'd', voiceProfile: 'gone', createdAt: 10 }];
  assert.equal(pickWellStyle(wells, ['b', 'a'], profiles)?.id, 'bedtime');
  assert.equal(pickWellStyle(wells, ['b'], profiles)?.id, 'energetic');
  assert.equal(pickWellStyle(wells, ['c', 'd'], profiles), null);
  assert.equal(pickWellStyle(wells, [], profiles), null);
});

test('monitor: DSN parsing and envelope url', () => {
  const d = parseDsn('https://abc123@o1.ingest.sentry.io/456')!;
  assert.deepEqual([d.key, d.host, d.projectId, d.path], ['abc123', 'o1.ingest.sentry.io', '456', '']);
  assert.equal(envelopeUrl(d), 'https://o1.ingest.sentry.io/api/456/envelope/?sentry_key=abc123&sentry_version=7');
  assert.equal(parseDsn('https://k@glitch.example.com/prefix/9')!.path, '/prefix');
  assert.equal(parseDsn('nonsense'), null);
  assert.equal(parseDsn(undefined), null);
});

test('monitor: scrubbing removes emails, tokens and keys', () => {
  const dirty = 'fail for ana@example.com with Bearer abc.def.ghi and sb_secret_XyZ123 at /x?token=SECRET&a=1 jwt eyJhbGciOi.eyJzdWIiOi.sig-nature';
  const clean = scrub(dirty);
  for (const leak of ['ana@example.com', 'abc.def.ghi', 'XyZ123', 'SECRET', 'eyJhbGciOi']) assert.equal(clean.includes(leak), false, leak);
  assert.ok(clean.includes('a=1'));
});

test('monitor: envelope shape, user id only, no email', () => {
  const dsn = parseDsn('https://k@h.io/1')!;
  const err = new Error('Boom for ana@example.com');
  const env = buildEnvelope({ error: err, where: 'sync', userId: 'u-1', extra: { docs: 3 } }, { dsn, environment: 'test', platform: 'javascript', now: 1_700_000_000_000, eventId: 'e'.repeat(32) });
  const [h, i, e] = env.split('\n').map((l) => JSON.parse(l));
  assert.equal(h.event_id, 'e'.repeat(32)); assert.equal(i.type, 'event');
  assert.equal(e.tags.where, 'sync'); assert.deepEqual(e.user, { id: 'u-1' });
  assert.equal(JSON.stringify(e).includes('ana@example.com'), false);
});

test('monitor: disabled without DSN, dedupes repeats, caps floods, survives network failure', async () => {
  assert.equal(await createReporter({}).capture({ error: new Error('x'), where: 'a' }), false);
  const calls: string[] = [];
  let t = 1_000_000;
  const r = createReporter({ dsn: 'https://k@h.io/1', now: () => t, fetchImpl: (async (u: string) => { calls.push(u); return new Response('ok'); }) as unknown as typeof fetch });
  assert.equal(await r.capture({ error: new Error('same'), where: 'a' }), true);
  assert.equal(await r.capture({ error: new Error('same'), where: 'a' }), false); // duplicate within a minute
  t += 61_000;
  assert.equal(await r.capture({ error: new Error('same'), where: 'a' }), true);
  let sent = 0;
  for (let i = 0; i < 50; i++) if (await r.capture({ error: new Error(`e${i}`), where: 'b' })) sent++;
  assert.ok(sent <= 30);
  const failing = createReporter({ dsn: 'https://k@h.io/1', fetchImpl: (async () => { throw new Error('offline'); }) as unknown as typeof fetch });
  assert.equal(await failing.capture({ error: new Error('x'), where: 'a' }), false);
});
