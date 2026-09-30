import { hasFeature, limitFor, minimumPlanFor, type Feature, type Metric, type Plan } from '../../../packages/billing/src/plans.ts';
import { rest } from './supa.ts';

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

export async function getPlan(userId: string): Promise<Plan> {
  const rows = await rest<Array<{ plan: Plan; active: boolean; expires_at: string | null }>>(
    `entitlements?user_id=eq.${userId}&product=eq.earshelf&select=plan,active,expires_at`);
  const r = rows[0];
  if (!r || !r.active) return 'free';
  if (r.expires_at && new Date(r.expires_at) < new Date()) return 'free';
  return r.plan;
}

export function requireFeature(plan: Plan, feature: Feature) {
  if (!hasFeature(plan, feature)) throw new HttpError(402, 'upgrade_required', `This needs the ${minimumPlanFor(feature)} plan.`);
}

export async function consume(userId: string, plan: Plan, metric: Metric, amount: number) {
  const limit = limitFor(plan, metric);
  const rows = await rest<Array<{ is_allowed: boolean; total_used: number }>>('rpc/consume_usage', {
    method: 'POST', body: { p_user: userId, p_product: 'earshelf', p_metric: metric, p_amount: amount, p_limit: limit },
  });
  const r = rows[0];
  if (!r?.is_allowed) throw new HttpError(429, 'limit_reached', `You have used this month's ${metric.replace(/_/g, ' ')} allowance on the ${plan} plan.`);
  return { used: r.total_used, limit };
}
