import { handleWebhook, type BillingStore, type EventResult, type LsPayload } from '../../../packages/billing/src/lemonsqueezy.ts';
import { config } from './config.ts';
import { rest } from './supa.ts';

const store: BillingStore = {
  async hasProcessed(eventId) {
    const rows = await rest<unknown[]>(`billing_events?event_id=eq.${encodeURIComponent(eventId)}&select=event_id`);
    return rows.length > 0;
  },
  async apply(r: EventResult, payload: LsPayload) {
    if (r.subscription) {
      const s = r.subscription;
      await rest('subscriptions?on_conflict=provider,provider_subscription_id', {
        method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
        body: { user_id: s.userId, provider: s.provider, provider_subscription_id: s.providerSubscriptionId, variant_id: s.variantId, status: s.status, renews_at: s.renewsAt, ends_at: s.endsAt },
      });
    }
    if (r.entitlement) {
      const e = r.entitlement;
      await rest('entitlements?on_conflict=user_id,product', {
        method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
        body: { user_id: e.userId, product: e.product, plan: e.plan, active: e.active, source: 'lemonsqueezy', expires_at: e.expiresAt },
      });
    }
    // Recorded last, so a failed apply is retried by Lemon Squeezy instead of being marked as processed.
    await rest('billing_events', { method: 'POST', prefer: 'return=minimal', body: { provider: 'lemonsqueezy', event_id: r.eventId, event_type: r.eventName, payload, processed_at: new Date().toISOString() } });
  },
};

export function processWebhook(raw: string, signature: string | undefined) {
  return handleWebhook(raw, signature, { signingSecret: config.ls.secret, variants: { plus: config.ls.plus, pro: config.ls.pro } }, store);
}
