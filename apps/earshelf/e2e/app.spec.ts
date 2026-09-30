import { expect, test } from '@playwright/test';

// These run the app on this device only (no Supabase configured), which is how a first-time visitor sees it.
const SAMPLE = '# Field notes\n\nThe first paragraph explains the idea. It has two sentences.\n\n## Part two\n\nA second section follows here with more words to read aloud.';

async function addSample(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /add/i }).first().click();
  await page.locator('input[type=file]').setInputFiles({ name: 'sample.md', mimeType: 'text/markdown', buffer: Buffer.from(SAMPLE) });
  await expect(page.getByText('We found')).toBeVisible();
  await page.getByRole('button', { name: 'Add to library' }).click();
}

test('empty library invites the first import', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your library is empty' })).toBeVisible();
});

test('import a document, see the review step, and open it', async ({ page }) => {
  await addSample(page);
  await expect(page.getByRole('heading', { name: 'Field notes' }).first()).toBeVisible();
  await expect(page.getByText('The first paragraph explains the idea.')).toBeVisible();
});

test('create a well and add the document to it', async ({ page }) => {
  await addSample(page);
  await page.getByRole('button', { name: 'Back to library' }).click();
  await page.getByRole('button', { name: /options for/i }).click();
  await page.getByLabel('Research').check();
  await page.keyboard.press('Escape'); // dialog closes on Escape
  await page.getByRole('button', { name: 'Wells' }).last().click();
  await page.getByRole('button', { name: /Research/ }).click();
  await expect(page.getByText('Field notes')).toBeVisible();
});

test('the player appears with the transport controls', async ({ page }) => {
  await addSample(page);
  await expect(page.getByRole('region', { name: 'Player' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back 15 seconds' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Open full player' }).click();
  await expect(page.getByRole('dialog', { name: 'Full player' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Forward 30 seconds' })).toBeVisible();
});

test('library still opens offline after the first visit', async ({ page, context }) => {
  await addSample(page);
  await page.waitForTimeout(2000); // let the service worker cache the app
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText(/You’re offline/)).toBeVisible();
  await expect(page.getByText('Field notes').first()).toBeVisible();
});
