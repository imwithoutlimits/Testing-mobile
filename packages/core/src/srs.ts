export type Grade = 'again' | 'hard' | 'good' | 'easy';

export interface SrsState {
  ease: number;          // growth factor, never below 1.3
  intervalDays: number;  // 0 while a card is being relearned
  reps: number;          // successful reviews in a row
  lapses: number;        // times the card was forgotten
  dueAt: number;         // epoch ms
}

export const NEW_CARD_STATE = (now = Date.now()): SrsState => ({ ease: 2.5, intervalDays: 0, reps: 0, lapses: 0, dueAt: now });

const DAY = 86_400_000;
const MIN = 60_000;
const MIN_EASE = 1.3;

/** SM-2 style scheduling with four buttons. Pure: returns the next state and never mutates the old one. */
export function schedule(s: SrsState, grade: Grade, now = Date.now()): SrsState {
  if (grade === 'again') {
    return { ease: Math.max(MIN_EASE, s.ease - 0.2), intervalDays: 0, reps: 0, lapses: s.lapses + 1, dueAt: now + 10 * MIN };
  }
  let days: number;
  if (s.reps === 0) days = grade === 'hard' ? 1 : grade === 'good' ? 1 : 3;
  else if (s.reps === 1) days = grade === 'hard' ? 3 : grade === 'good' ? 6 : 8;
  else days = Math.round(s.intervalDays * (grade === 'hard' ? 1.2 : grade === 'good' ? s.ease : s.ease * 1.3));
  if (grade !== 'hard') days = Math.max(days, Math.round(s.intervalDays) + 1); // always move forward
  const ease = grade === 'hard' ? Math.max(MIN_EASE, s.ease - 0.15) : grade === 'easy' ? s.ease + 0.15 : s.ease;
  return { ease, intervalDays: Math.max(1, days), reps: s.reps + 1, lapses: s.lapses, dueAt: now + Math.max(1, days) * DAY };
}

export const isDue = (s: SrsState, now = Date.now()) => s.dueAt <= now;
/** Cards you keep forgetting, or that stay hard, are worth a focused pass. */
export const isWeak = (s: SrsState) => s.lapses >= 2 || (s.reps > 0 && s.ease < 1.8);

export function pickDue<T extends SrsState>(cards: T[], now = Date.now(), limit = 20, weakOnly = false): T[] {
  return cards.filter((c) => isDue(c, now) && (!weakOnly || isWeak(c))).sort((a, b) => a.dueAt - b.dueAt).slice(0, limit);
}

/** What each button will do, shown on the button so the choice is never a mystery. */
export function previewInterval(s: SrsState, grade: Grade, now = Date.now()): string {
  const next = schedule(s, grade, now);
  if (grade === 'again') return '10 min';
  return next.intervalDays === 1 ? '1 day' : next.intervalDays < 30 ? `${next.intervalDays} days` : `${Math.round(next.intervalDays / 30)} mo`;
}
