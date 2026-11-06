import { expect, test } from '@playwright/test';

test('the vinyl shell has one transport surface and no button row', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.wordmark')).toHaveText('localtune.');

  for (const testid of ['vip-open', 'settings-open', 'theme-toggle', 'panel-open']) {
    await expect(page.locator(`[data-testid="${testid}"]`)).toHaveCount(1);
  }
  await expect(page.locator('[data-testid="search-open"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="settings-close"]')).toBeHidden();
  await expect(page.locator('.controls')).toHaveCount(0);
  await expect(page.locator('.progress')).toHaveCount(0);
  await expect(page.locator('.scan')).toHaveCount(0);
  await expect(page.locator('#status')).toBeHidden();

  await expect(page.locator('#armRotor')).toHaveCount(1);
  await expect(page.locator('#armRotor')).toHaveAttribute('role', 'slider');
  await expect(page.locator('#armRotor')).toHaveAttribute('data-playing', 'false');

  const tabs = page.locator('.tabs [role="tab"]');
  await expect(tabs).toHaveCount(2);
  await expect(tabs).toHaveText(['队列', '文件夹']);
  await expect(page.locator('[data-testid="search-input"]')).toBeVisible();

  await expect(page.locator('[data-testid="lyrics-open"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="lyrics-view"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="lyrics-host"]')).toHaveCount(0);
});

test('the top close button leaves settings', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-testid="settings-open"]').click();

  await expect(page.locator('[data-testid="settings-section-playback"]')).toBeVisible();
  await expect(page.locator('[data-testid="settings-close"]')).toBeHidden();
  await expect(page.locator('[data-testid="panel-open"]')).toBeVisible();
  await expect(page.locator('[data-testid="panel-open"]')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.settings-view h2')).toHaveCount(0);

  await page.locator('[data-testid="panel-open"]').click();
  await expect(page.locator('#tab-folders')).toBeVisible();
  await expect(page.locator('[data-testid="settings-close"]')).toBeHidden();
  await expect(page.locator('[data-testid="settings-open"]')).toBeVisible();
});

test('the VIP panel offers a single Downtify download card', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-testid="vip-open"]').click();

  await expect(page.locator('[data-testid="vip-view"]')).toBeVisible();
  await expect(page.locator('[data-testid="vip-head"]')).toBeVisible();
  await expect(page.locator('[data-testid="vip-head"] h2')).toHaveText('VIP');
  await expect(page.locator('[data-testid="vip-placeholder"]')).toHaveText('更好的下载正在开发中');
  await expect(page.locator('[data-testid="vip-temporary"]')).toHaveText('暂时先用 Downtify。');
  await expect(page.locator('[data-testid="vip-downtify"]')).toBeVisible();

  await expect(page.locator('[data-testid="playlist-view"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="import-open"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="vip-playlist-settings"]')).toHaveCount(0);

  const github = page.locator('[data-testid="vip-downtify-github"]');
  await expect(github).toHaveAttribute('href', 'https://github.com/henriquesebastiao/downtify');
  await expect(github).toHaveAttribute('target', '_blank');
  await expect(github).toHaveAttribute('rel', /noreferrer/);
  await expect(github).toHaveAttribute('rel', /noopener/);
  await expect(github).toBeVisible();

  const docs = page.locator('[data-testid="vip-downtify-docs"]');
  await expect(docs).toHaveAttribute('href', 'https://downtify.henriquesebastiao.com/');
  await expect(docs).toBeVisible();

  await page.locator('[data-testid="panel-open"]').click();
  await expect(page.locator('#tab-folders')).toBeVisible();
});

for (const width of [360, 390]) {
  test.describe(`${width}px viewport`, () => {
    test.use({ viewport: { width, height: 780 } });

    test('the Downtify card fits inside the viewport', async ({ page }) => {
      await page.goto('/');
      await page.locator('[data-testid="vip-open"]').click();

      const card = page.locator('[data-testid="vip-downtify"]');
      await expect(card).toBeVisible();
      await card.scrollIntoViewIfNeeded();

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, 'the page does not scroll horizontally').toBeLessThanOrEqual(0);

      const box = await card.boundingBox();
      expect(box, 'the card has a box').not.toBeNull();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y).toBeGreaterThanOrEqual(-1);
      expect(box.y + box.height).toBeLessThanOrEqual(781);

      await page.screenshot({ path: `test-results/vip-downtify-${width}.png` });
    });
  });
}

test.describe('360px viewport', () => {
  test.use({ viewport: { width: 360, height: 780 } });

  test('the stage and the arm fit above the inline library', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.wordmark')).toHaveText('localtune.');

    const deck = page.locator('.deck');
    await expect(deck).toBeVisible();
    const box = await deck.boundingBox();
    expect(box, 'the deck has a box').not.toBeNull();
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(780);

    const disc = await page.locator('.vinyl').boundingBox();
    expect(disc).not.toBeNull();
    expect(Math.abs(disc.x + disc.width / 2 - 180)).toBeLessThanOrEqual(2);
    const arm = await page.locator('.arm-rest-knob').boundingBox();
    expect(arm).not.toBeNull();
    expect(arm.x + arm.width).toBeLessThanOrEqual(358);

    // The playlist is in normal flow below the stage on phones.
    const panel = await page.locator('.panel').boundingBox();
    expect(panel).not.toBeNull();
    expect(panel.y).toBeGreaterThanOrEqual(box.y + box.height - 1);
    await expect(page.locator('#tab-folders')).toBeVisible();

    await expect(page.locator('.controls')).toHaveCount(0);
    await expect(page.locator('.progress')).toHaveCount(0);
  });
});
