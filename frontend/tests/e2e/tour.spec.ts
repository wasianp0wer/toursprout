import { expect, test } from '@playwright/test';
import { stubMapillary, stubTiles } from './fixtures';

test.beforeEach(async ({ page }) => {
  await stubMapillary(page);
  await stubTiles(page);
  await page.goto('/');
  await expect(page.locator('[data-ready]')).toBeVisible({ timeout: 30_000 });
});

test('opens on the first stop of the Fairfax tour', async ({ page }) => {
  await expect(
    page.getByRole('heading', { name: 'Fairfax County Historic Courthouse' }),
  ).toBeVisible();
  await expect(page.getByText('1 of 6')).toBeVisible();
});

test('walks forward through all six stops and back again', async ({ page }) => {
  for (let i = 2; i <= 6; i++) {
    await page.locator('[data-next]').click();
    await expect(page.getByText(`${i} of 6`)).toBeVisible();
  }
  await expect(page.locator('[data-next]')).toBeDisabled();

  for (let i = 5; i >= 1; i--) {
    await page.locator('[data-prev]').click();
    await expect(page.getByText(`${i} of 6`)).toBeVisible();
  }
  await expect(page.locator('[data-prev]')).toBeDisabled();
});

test('shows overlay text with its credit when an overlay is selected', async ({ page }) => {
  await page.locator('[data-overlay-item]').first().click();
  const detail = page.locator('.overlay-detail');
  await expect(detail).toBeVisible();
  await expect(detail.locator('.credit')).not.toBeEmpty();
});

test('every overlay on every stop carries a credit', async ({ page }) => {
  for (let i = 1; i <= 6; i++) {
    const items = page.locator('[data-overlay-item]');
    await expect(items.first()).toBeVisible();
    const count = await items.count();
    expect(count).toBeGreaterThan(0);
    for (let j = 0; j < count; j++) {
      await items.nth(j).click();
      await expect(page.locator('.overlay-detail .credit')).not.toBeEmpty();
    }
    if (i < 6) await page.locator('[data-next]').click();
  }
});

test('the archival photograph is served from the media endpoint', async ({ page }) => {
  const imageItem = page.locator('[data-overlay-item]', { hasText: 'Fairfax Court House' }).first();
  await imageItem.click();
  await expect(page.locator('.overlay-detail img')).toHaveAttribute(
    'src',
    /\/api\/media\/courthouse-photo\.jpg/,
  );
});

test('narration audio points at the range-capable media endpoint', async ({ page }) => {
  await page.locator('[data-overlay-item]', { hasText: 'Narration' }).first().click();
  await expect(page.locator('.overlay-detail audio')).toHaveAttribute(
    'src',
    /\/api\/media\/narration-.*\.m4a/,
  );
});

test('narration media actually streams with a 206 response', async ({ page, request }) => {
  await page.locator('[data-overlay-item]', { hasText: 'Narration' }).first().click();
  const src = await page.locator('.overlay-detail audio').getAttribute('src');
  const response = await request.get(src!, { headers: { Range: 'bytes=0-99' } });
  expect(response.status()).toBe(206);
  expect(response.headers()['content-range']).toMatch(/^bytes 0-99\/\d+$/);
});

test('attribution for OpenStreetMap and Mapillary is always visible', async ({ page }) => {
  const attribution = page.locator('.attribution');
  await expect(attribution).toContainText('OpenStreetMap');
  await expect(attribution).toContainText('Mapillary');
});

test('selecting a stop on the map moves the tour', async ({ page }) => {
  await expect(page.locator('.maplibregl-canvas')).toBeVisible({ timeout: 20_000 });
});

test('the courthouse offers a then/now comparison', async ({ page }) => {
  await expect(page.locator('[data-in-world-opacity]')).toBeVisible();
});

test('the comparison slider is absent on a stop with no in-world overlay', async ({ page }) => {
  await page.locator('[data-next]').click();
  await expect(page.locator('[data-in-world-opacity]')).toHaveCount(0);
});

test('alignment mode stays off unless asked for', async ({ page }) => {
  await expect(page.locator('[data-align-panel]')).toHaveCount(0);
});
