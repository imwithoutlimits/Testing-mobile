import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { checkUsage, hasFeature, minimumPlanFor } from './plans.ts';
import { handleWebhook, verifySignature, type BillingStore, type EventResult, type LsPayload } from './lemonsqueezy.ts';

const SECRET = 'whsec_test';
const variants = { plus: '111', pro: '222' };
const sign = (body: string) => createHmac('sha256', SECRET).update(body).digest('hex');
const payload = (event: string, attrs: Record<string, unknown>, user = 'u1'): LsPayload => ({
  meta: { event_name: event, custom_data: { user_id: user } },
  data: { id: '9001', type: 'subscriptions', attributes: { variant_id: 111, updated_at: '2026-09-28T10:00:00Z', ...attrs } },
});

function memStore() {
  const seen = new Set<string>();
  const applied: EventResult[] = [];
  const store: BillingStore = {
    hasProcessed: async (id) => seen.has(id),
    apply: async (r) => { seen.add(r.eventId); applied.push(r); },
  };
  return { store, applied };
}
const env = { signingSecret: SECRET, variants };

test('signature verification', () => {
  const body = '{"a":1}';
  assert.ok(verifySignature(body, sign(body), SECRET));
  assert.ok(!verifySignature(body, sign('{"a":2}'), SECRET));
  assert.ok(!verifySignature(body, undefined, SECRET));
  assert.ok(!verifySignature(body, 'zz-not-hex', SECRET));
});

test('rejects bad signature and malformed payloads; grants nothing', async () => {
  const { store, applied } = memStore();
  const body = JSON.stringify(payload('subscription_created', { status: 'active' }));
  assert.equal((await handleWebhook(body, 'deadbeef', env, store)).status, 401);
  const junk = 'not json';
  assert.equal((await handleWebhook(junk, sign(junk), env, store)).status, 400);
  assert.equal(applied.length, 0);
});

test('subscription_created grants plan; duplicate delivery is idempotent', async () => {
  const { store, applied } = memStore();
  const body = JSON.stringify(payload('subscription_created', { status: 'active', renews_at: '2026-10-28T00:00:00Z' }));
  const first = await handleWebhook(body, sign(body), env, store);
  assert.equal(first.status, 200);
  if (first.status === 200) assert.equal(first.result.entitlement?.plan, 'plus');
  const second = await handleWebhook(body, sign(body), env, store);
  if (second.status === 200) assert.equal(second.result.duplicate, true);
  assert.equal(applied.length, 1);
});

test('pro variant maps to pro; unknown variant is free/inactive', async () => {
  const { store } = memStore();
  const pro = JSON.stringify(payload('subscription_updated', { status: 'active', variant_id: 222 }));
  const r1 = await handleWebhook(pro, sign(pro), env, store);
  if (r1.status === 200) assert.equal(r1.result.entitlement?.plan, 'pro');
  const unk = JSON.stringify(payload('subscription_updated', { status: 'active', variant_id: 999, updated_at: 'x' }));
  const r2 = await handleWebhook(unk, sign(unk), env, store);
  if (r2.status === 200) assert.equal(r2.result.entitlement?.active, false);
});

test('cancelled keeps access until ends_at; expired and refund revoke', async () => {
  const { store } = memStore();
  const now = new Date('2026-09-28T12:00:00Z');
  const future = JSON.stringify(payload('subscription_cancelled', { status: 'cancelled', ends_at: '2026-10-15T00:00:00Z' }));
  const a = await handleWebhook(future, sign(future), env, store, now);
  if (a.status === 200) assert.equal(a.result.entitlement?.active, true);
  const past = JSON.stringify(payload('subscription_cancelled', { status: 'cancelled', ends_at: '2026-09-01T00:00:00Z', updated_at: 'p' }));
  const b = await handleWebhook(past, sign(past), env, store, now);
  if (b.status === 200) assert.equal(b.result.entitlement?.active, false);
  const exp = JSON.stringify(payload('subscription_expired', { status: 'expired', updated_at: 'e' }));
  const c = await handleWebhook(exp, sign(exp), env, store, now);
  if (c.status === 200) assert.equal(c.result.entitlement?.plan, 'free');
  const ref = JSON.stringify({ meta: { event_name: 'order_refunded', custom_data: { user_id: 'u1' } }, data: { id: '5', type: 'orders', attributes: { refunded: true } } });
  const d = await handleWebhook(ref, sign(ref), env, store, now);
  if (d.status === 200) assert.equal(d.result.entitlement?.active, false);
});

test('missing user_id is ignored, not granted', async () => {
  const { store, applied } = memStore();
  const p = payload('subscription_created', { status: 'active' });
  delete p.meta.custom_data;
  const body = JSON.stringify(p);
  const r = await handleWebhook(body, sign(body), env, store);
  if (r.status === 200) assert.ok(r.result.ignored);
  assert.equal(applied[0].entitlement, undefined);
});

test('feature gates and usage limits', () => {
  assert.equal(hasFeature('free', 'ocr'), false);
  assert.equal(hasFeature('plus', 'ocr'), true);
  assert.equal(hasFeature('plus', 'ask_document'), false);
  assert.equal(hasFeature('pro', 'quizzes'), true);
  assert.equal(minimumPlanFor('ask_document'), 'pro');
  assert.equal(checkUsage('free', 'documents', 4).allowed, true);
  assert.equal(checkUsage('free', 'documents', 5).allowed, false);
  assert.equal(checkUsage('pro', 'offline_items', 10_000).allowed, true);
  assert.equal(checkUsage('plus', 'ai_requests', 95, 10).allowed, false);
});
