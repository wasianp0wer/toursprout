import type { Page } from '@playwright/test';

/**
 * Block every Mapillary request and serve a deterministic stub instead, so the
 * suite needs no access token and no network. The panorama cannot render real
 * imagery under these conditions, so these tests assert on tour navigation,
 * overlays and credits rather than on pixels.
 */
export async function stubMapillary(page: Page): Promise<void> {
  await page.route(/mapillary\.com/, (route) => {
    const url = route.request().url();
    if (/\.jpg|\.jpeg|\.png/.test(url)) {
      return route.fulfill({ status: 200, contentType: 'image/jpeg', body: '' });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [] }),
    });
  });
}

/** OSM tiles are equally irrelevant to what these tests assert. */
export async function stubTiles(page: Page): Promise<void> {
  await page.route(/tile\.openstreetmap\.org/, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: '' }),
  );
}
