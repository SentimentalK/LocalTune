import { expect, test } from '@playwright/test';

test('the shell has two tabs, one progress bar and three header actions', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#app h1')).toHaveText('LocalTune');

  const header = page.locator('header.top');
  for (const testid of ['search-open', 'vip-open', 'settings-open']) {
    await expect(header.locator(`[data-testid="${testid}"]`)).toHaveCount(1);
  }
  await expect(page.locator('[data-testid="settings-close"]')).toBeHidden();
  await expect(page.locator('.count')).toHaveCount(0);
  await expect(page.locator('.source-name')).toHaveCount(0);
  await expect(header.locator('.scan')).toHaveCount(1);
  await expect(page.locator('.scan')).toHaveCount(1);
  await expect(page.locator('#status')).toBeHidden();

  const tabs = page.locator('.tabs [role="tab"]');
  await expect(tabs).toHaveCount(2);
  await expect(tabs).toHaveText(['文件夹', '队列']);
  await expect(page.locator('[data-testid="lyrics-open"]')).toHaveCount(0);
});

test('the header close button leaves settings', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-testid="settings-open"]').click();

  await expect(page.locator('[data-testid="settings-section-playback"]')).toBeVisible();
  await expect(page.locator('[data-testid="settings-open"]')).toBeHidden();
  await expect(page.locator('[data-testid="search-open"]')).toBeHidden();
  await expect(page.locator('[data-testid="vip-open"]')).toBeHidden();
  await expect(page.locator('[data-testid="settings-close"]')).toBeVisible();
  await expect(page.locator('.settings-head')).toHaveCount(0);

  await page.locator('[data-testid="settings-close"]').click();
  await expect(page.locator('#tab-folders')).toBeVisible();
  await expect(page.locator('[data-testid="settings-close"]')).toBeHidden();
  await expect(page.locator('[data-testid="settings-open"]')).toBeVisible();
});

test('the VIP view hosts the playlists', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-testid="vip-open"]').click();

  await expect(page.locator('[data-testid="vip-view"]')).toBeVisible();
  await expect(page.locator('[data-testid="vip-placeholder"]')).toBeVisible();
  await expect(page.locator('[data-testid="playlist-view"]')).toBeVisible();
  await expect(page.locator('[data-testid="import-open"]')).toBeVisible();
  await expect(page.locator('[data-testid="settings-open"]')).toBeHidden();

  await page.locator('[data-testid="settings-close"]').click();
  await expect(page.locator('#tab-folders')).toBeVisible();
});

test.describe('360px viewport', () => {
  test.use({ viewport: { width: 360, height: 780 } });

  test('the transport controls stay on one line inside the viewport', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app h1')).toHaveText('LocalTune');

    const controls = page.locator('.controls');
    await expect(controls).toBeVisible();
    const buttons = controls.locator('.btn');
    await expect(buttons).toHaveCount(5);

    // Shuffle, previous, play, next, repeat: the three transport buttons in the
    // middle are the ones that must never collide or overflow.
    const boxes = [];
    for (const index of [1, 2, 3]) {
      const box = await buttons.nth(index).boundingBox();
      expect(box, `button ${index} has a box`).not.toBeNull();
      boxes.push(box);
    }

    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(360);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(780);
    }

    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        expect(overlapX <= 0 || overlapY <= 0, `buttons ${i} and ${j} do not overlap`).toBe(true);
      }
    }

    const sorted = boxes.slice().sort((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i += 1) {
      const gap = sorted[i].x - (sorted[i - 1].x + sorted[i - 1].width);
      expect(gap, `gap ${i}`).toBeGreaterThanOrEqual(8);
    }

    // One row: the three boxes share a horizontal band (no wrapping).
    const top = Math.max(...boxes.map((box) => box.y));
    const bottom = Math.min(...boxes.map((box) => box.y + box.height));
    expect(bottom - top).toBeGreaterThan(0);
  });
});
