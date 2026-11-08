import { expect, test } from '@playwright/test';

test('the vinyl shell has one transport surface and no button row', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.wordmark')).toHaveText('localtune.');

  for (const testid of ['settings-open', 'theme-toggle', 'panel-open']) {
    await expect(page.locator(`[data-testid="${testid}"]`)).toHaveCount(1);
  }
  await expect(page.locator('[data-testid="search-open"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="settings-open"]')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-testid="settings-close"]')).toHaveCount(0);
  await expect(page.locator('#settingsKicker')).toHaveCount(0);
  await expect(page.locator('.controls')).toHaveCount(0);
  await expect(page.locator('.progress')).toHaveCount(0);
  await expect(page.locator('.scan')).toHaveCount(0);
  await expect(page.locator('#status')).toBeHidden();

  await expect(page.locator('#armRotor')).toHaveCount(1);
  await expect(page.locator('#armRotor')).toHaveAttribute('role', 'slider');
  await expect(page.locator('#armRotor')).toHaveAttribute('data-playing', 'false');

  // One fixed speed, and no 33⅓ plate anywhere on the disc.
  await expect(page.locator('.rpm-tag')).toHaveCount(0);
  await expect(page.locator('.deck')).not.toContainText('33⅓');
  await expect(page.locator('[data-testid="rpm-switch"]')).toHaveCount(0);
  await expect(page.locator('.deck')).not.toHaveAttribute('data-rpm', /.*/);

  const tabs = page.locator('.tabs [role="tab"]');
  await expect(tabs).toHaveCount(2);
  await expect(tabs).toHaveText(['队列', '文件夹']);
  await expect(page.locator('[data-testid="search-input"]')).toBeVisible();

  await expect(page.locator('[data-testid="lyrics-open"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="lyrics-view"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="lyrics-host"]')).toHaveCount(0);
});

test('the top bar settings button switches the desktop panel', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-testid="settings-open"]').click();

  await expect(page.locator('[data-testid="settings-section-playback"]')).toBeVisible();
  await expect(page.locator('[data-testid="settings-open"]')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-testid="panel-open"]')).toBeVisible();
  await expect(page.locator('[data-testid="panel-open"]')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.settings-view h2')).toHaveCount(0);

  await page.locator('[data-testid="panel-open"]').click();
  await expect(page.locator('#tab-folders')).toBeVisible();
  await expect(page.locator('[data-testid="settings-open"]')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-testid="settings-open"]')).toBeVisible();
});

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
