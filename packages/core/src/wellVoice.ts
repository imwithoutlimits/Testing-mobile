export interface StyleProfile { id: string; rate: number; pause: number }
export interface WellLike { id: string; voiceProfile?: string; createdAt: number }

/**
 * A document listened to from a well takes that well's voice style. If it sits in several wells with styles,
 * the oldest well wins, so the result never depends on the order things were loaded in.
 */
export function pickWellStyle(wells: WellLike[], memberOf: string[], profiles: StyleProfile[]): StyleProfile | null {
  const member = new Set(memberOf);
  const styled = wells
    .filter((w) => member.has(w.id) && w.voiceProfile && profiles.some((p) => p.id === w.voiceProfile))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return styled.length ? profiles.find((p) => p.id === styled[0].voiceProfile) ?? null : null;
}
