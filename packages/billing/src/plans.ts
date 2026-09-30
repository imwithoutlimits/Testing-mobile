export type Plan = 'free' | 'plus' | 'pro';
export type Metric = 'documents' | 'server_tts_minutes' | 'ocr_pages' | 'ai_requests' | 'offline_items';

export type Feature =
  | 'ocr' | 'natural_tts' | 'offline_audio' | 'summaries' | 'notes_highlights' | 'sync'
  | 'pronunciation' | 'semantic_search' | 'ask_document' | 'quizzes' | 'cross_document_search'
  | 'audio_export' | 'multi_speaker' | 'batch_processing' | 'table_figure_explain';

const PLUS: Feature[] = ['ocr', 'natural_tts', 'offline_audio', 'summaries', 'notes_highlights', 'sync', 'pronunciation', 'semantic_search'];
const PRO: Feature[] = [...PLUS, 'ask_document', 'quizzes', 'cross_document_search', 'audio_export', 'multi_speaker', 'batch_processing', 'table_figure_explain'];

export const PLAN_FEATURES: Record<Plan, ReadonlySet<Feature>> = {
  free: new Set<Feature>(),
  plus: new Set(PLUS),
  pro: new Set(PRO),
};

/** -1 means unlimited. Monthly counters except documents/offline_items which are totals. */
export const PLAN_LIMITS: Record<Plan, Record<Metric, number>> = {
  free: { documents: 5, server_tts_minutes: 0, ocr_pages: 0, ai_requests: 5, offline_items: 2 },
  plus: { documents: 100, server_tts_minutes: 600, ocr_pages: 300, ai_requests: 100, offline_items: 50 },
  pro: { documents: 1000, server_tts_minutes: 3000, ocr_pages: 2000, ai_requests: 1000, offline_items: -1 },
};

export function hasFeature(plan: Plan, feature: Feature): boolean {
  return PLAN_FEATURES[plan].has(feature);
}

export function limitFor(plan: Plan, metric: Metric): number {
  return PLAN_LIMITS[plan][metric];
}

export interface UsageCheck {
  allowed: boolean;
  remaining: number; // Infinity when unlimited
  limit: number;
}

export function checkUsage(plan: Plan, metric: Metric, used: number, requested = 1): UsageCheck {
  const limit = limitFor(plan, metric);
  if (limit < 0) return { allowed: true, remaining: Infinity, limit };
  const remaining = Math.max(0, limit - used);
  return { allowed: requested <= remaining, remaining, limit };
}

const RANK: Record<Plan, number> = { free: 0, plus: 1, pro: 2 };
export function minimumPlanFor(feature: Feature): Plan {
  return (['plus', 'pro'] as const).find((p) => PLAN_FEATURES[p].has(feature)) ?? 'pro';
}
export function planAtLeast(plan: Plan, min: Plan): boolean {
  return RANK[plan] >= RANK[min];
}
