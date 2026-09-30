import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import type { Plan } from './plans.ts';

/** Verifies the X-Signature header (hex HMAC-SHA256 of the raw request body). */
export function verifySignature(rawBody: string | Uint8Array, signatureHeader: string | undefined | null, secret: string): boolean {
  if (!signatureHeader || !secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  let given: Buffer;
  try {
    given = Buffer.from(signatureHeader.trim(), 'hex');
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export const HANDLED_EVENTS = [
  'subscription_created', 'subscription_updated', 'subscription_cancelled', 'subscription_expired',
  'subscription_payment_success', 'subscription_payment_failed', 'order_refunded',
] as const;
export type HandledEvent = (typeof HANDLED_EVENTS)[number];

export interface LsPayload {
  meta: { event_name: string; custom_data?: { user_id?: string; product?: string } };
  data: {
    id: string;
    type: string;
    attributes: {
      status?: string;
      variant_id?: number | string;
      renews_at?: string | null;
      ends_at?: string | null;
      updated_at?: string;
      subscription_id?: number | string;
      refunded?: boolean;
      [k: string]: unknown;
    };
  };
}

export interface VariantMap {
  plus: string;
  pro: string;
}

export interface EntitlementUpdate {
  userId: string;
  product: 'earshelf' | 'tapestry';
  plan: Plan;
  active: boolean;
  expiresAt: string | null;
}

export interface SubscriptionUpdate {
  provider: 'lemonsqueezy';
  providerSubscriptionId: string;
  userId: string;
  variantId: string;
  status: string;
  renewsAt: string | null;
  endsAt: string | null;
}

export interface EventResult {
  eventId: string;
  eventName: string;
  duplicate: boolean;
  ignored?: string;
  subscription?: SubscriptionUpdate;
  entitlement?: EntitlementUpdate;
}

/** Lemon Squeezy does not send a unique event id, so derive a stable one from the event content. */
export function deriveEventId(p: LsPayload): string {
  const a = p.data.attributes;
  const basis = [p.meta.event_name, p.data.type, p.data.id, a.status ?? '', a.updated_at ?? '', a.ends_at ?? '', a.renews_at ?? ''].join('|');
  return createHash('sha256').update(basis).digest('hex');
}

export function planForVariant(variantId: string, map: VariantMap): Plan {
  if (variantId === map.pro) return 'pro';
  if (variantId === map.plus) return 'plus';
  return 'free';
}

const GRACE_STATUSES = new Set(['active', 'on_trial', 'past_due']);

/** Pure decision function: payload in, DB updates out. The caller persists them and records the event. */
export function decide(payload: LsPayload, map: VariantMap, now = new Date()): Omit<EventResult, 'duplicate' | 'eventId'> {
  const eventName = payload.meta.event_name;
  const userId = payload.meta.custom_data?.user_id;
  const product = (payload.meta.custom_data?.product === 'tapestry' ? 'tapestry' : 'earshelf') as 'earshelf' | 'tapestry';
  if (!(HANDLED_EVENTS as readonly string[]).includes(eventName)) return { eventName, ignored: 'unhandled event' };
  if (!userId) return { eventName, ignored: 'missing user_id in custom checkout data' };

  const a = payload.data.attributes;

  if (eventName === 'order_refunded') {
    return {
      eventName,
      entitlement: { userId, product, plan: 'free', active: false, expiresAt: now.toISOString() },
    };
  }

  const isSubEvent = payload.data.type === 'subscriptions';
  const variantId = String(a.variant_id ?? '');
  const subId = String(isSubEvent ? payload.data.id : a.subscription_id ?? payload.data.id);
  const status = String(a.status ?? (eventName === 'subscription_expired' ? 'expired' : 'active'));
  const subscription: SubscriptionUpdate = {
    provider: 'lemonsqueezy',
    providerSubscriptionId: subId,
    userId,
    variantId,
    status,
    renewsAt: a.renews_at ?? null,
    endsAt: a.ends_at ?? null,
  };

  // Cancelled subscriptions keep access until ends_at. Expired/unpaid/paused do not.
  let active = GRACE_STATUSES.has(status);
  if (status === 'cancelled') active = !!a.ends_at && new Date(a.ends_at) > now;
  if (eventName === 'subscription_expired') active = false;

  const plan = active ? planForVariant(variantId, map) : 'free';
  return {
    eventName,
    subscription,
    entitlement: { userId, product, plan, active: active && plan !== 'free', expiresAt: a.ends_at ?? null },
  };
}

export interface BillingStore {
  hasProcessed(eventId: string): Promise<boolean>;
  apply(result: EventResult, payload: LsPayload): Promise<void>;
}

export type HandleOutcome =
  | { status: 401; error: string }
  | { status: 400; error: string }
  | { status: 200; result: EventResult };

/** Full webhook flow: verify signature, parse, dedupe, decide, persist. */
export async function handleWebhook(
  rawBody: string,
  signature: string | undefined,
  env: { signingSecret: string; variants: VariantMap },
  store: BillingStore,
  now = new Date(),
): Promise<HandleOutcome> {
  if (!verifySignature(rawBody, signature, env.signingSecret)) return { status: 401, error: 'invalid signature' };
  let payload: LsPayload;
  try {
    payload = JSON.parse(rawBody) as LsPayload;
    if (!payload?.meta?.event_name || !payload?.data?.id) throw new Error('shape');
  } catch {
    return { status: 400, error: 'malformed payload' };
  }
  const eventId = deriveEventId(payload);
  if (await store.hasProcessed(eventId)) {
    return { status: 200, result: { eventId, eventName: payload.meta.event_name, duplicate: true } };
  }
  const decision = decide(payload, env.variants, now);
  const result: EventResult = { eventId, duplicate: false, ...decision };
  await store.apply(result, payload);
  return { status: 200, result };
}
