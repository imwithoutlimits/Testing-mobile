import { expect, test } from '@playwright/test';

// Local-only checks for the newer screens. Signed-in features (meaning search, explanations, export) need a server.

test('no review card is shown until cards exist', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText(/to review|All caught up/)).toHaveCount(0);
});

test('a well can be given its own voice style', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Wells' }).last().click();
  await page.getByRole('button', { name: /Research/ }).click();
  const style = page.getByLabel('Voice style for this well');
  await expect(style).toBeVisible();
  await style.selectOption({ label: 'Bedtime — Slow and soft-paced' });
  await expect(style).toHaveValue('bedtime');
});

test('meaning search is not offered when signed out', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Search' }).last().click();
  await expect(page.getByLabel('Search by meaning')).toHaveCount(0);
});
