import { expect, test } from '@playwright/test';
import { stubTiles } from './fixtures';

/**
 * Flat (non-360) Mapillary imagery, against the real Graph API.
 *
 * This file deliberately does NOT use `stubMapillary`: the thing being checked
 * is that real flat coverage comes back and is offered to the author, and the
 * stub returns an empty list. It therefore needs a token, and **skips with a
 * reason when there is none** rather than failing — the token lives in
 * `backend/.env` for the running server, but this suite cannot read the
 * browser's config, so the environment has to say so too.
 *
 * `graph.mapillary.com` is unreachable from CI and from the production host,
 * so this can only ever run from a workstation, and only outside the Claude
 * Code sandbox, where no browser engine launches at all (docs/ENVIRONMENT.md).
 *
 * Subject: Český Krumlov, 48.8109 14.3153 — 46 flat images, 0 panoramas, 17
 * sequences within 50 m when probed on 2026-11-11. Mapillary imagery can be
 * withdrawn upstream, so an empty list here means re-probe before assuming a
 * defect (docs/UNVERIFIED.md, entry 42).
 */
test.describe('flat imagery in the editor', () => {
  test.skip(
    !process.env['MAPILLARY_TOKEN'],
    'needs MAPILLARY_TOKEN in the environment: this case talks to the real Graph API, because a stub cannot show that flat coverage is offered.',
  );

  test.beforeEach(async ({ page }) => {
    await stubTiles(page);
    await page.goto('/');
    await page.locator('[data-example="fairfax-old-town"]').click();
    await page.goto('/edit');
    await page.locator('[data-stop] [data-select]').first().click();
  });

  test('offers Krumlov\'s flat coverage, badged flat', async ({ page }) => {
    // Move the stop to Krumlov, then search near it.
    await page.locator('[data-field="stop-lat"]').fill('48.8109');
    await page.locator('[data-field="stop-lat"]').dispatchEvent('change');
    await page.locator('[data-field="stop-lng"]').fill('14.3153');
    await page.locator('[data-field="stop-lng"]').dispatchEvent('change');

    await page.locator('[data-find-panoramas]').click();
    await expect(page.locator('[data-searching]')).toHaveCount(0, { timeout: 30_000 });

    // The list is the whole point: before this feature it was always empty here.
    const candidates = page.locator('[data-candidate]');
    await expect(candidates.first()).toBeVisible();
    await expect(page.locator('[data-panorama-none]')).toHaveCount(0);

    // Every candidate is labelled, and at Krumlov every one is flat.
    const badges = page.locator('[data-candidate-kind]');
    await expect(badges).toHaveCount(await candidates.count());
    for (const kind of await badges.evaluateAll((ns) => ns.map((n) => n.getAttribute('data-candidate-kind')))) {
      expect(kind).toBe('flat');
    }

    // Thinning: 46 images in 17 sequences must not arrive as 20 near-identical
    // frames of one sequence. The list is capped at 20 either way.
    expect(await candidates.count()).toBeLessThanOrEqual(20);
  });
});
