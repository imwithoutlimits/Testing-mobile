export function checkoutUrl(plan: 'plus' | 'pro', user: { id: string; email?: string }): string | null {
  const base = plan === 'plus' ? import.meta.env.VITE_LS_CHECKOUT_PLUS : import.meta.env.VITE_LS_CHECKOUT_PRO;
  if (!base) return null;
  const u = new URL(base);
  // The webhook reads this to know whose account to upgrade. Access is only ever granted by the verified webhook.
  u.searchParams.set('checkout[custom][user_id]', user.id);
  u.searchParams.set('checkout[custom][product]', 'earshelf');
  if (user.email) u.searchParams.set('checkout[email]', user.email);
  return u.toString();
}
