import { expect, test } from '@playwright/test';

test('settings view covers library, storage, language and about', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#app h1')).toHaveText('LocalTune');

  await page.locator('[data-testid="settings-open"]').click();

  for (const section of ['library', 'storage', 'playback', 'language', 'about']) {
    await expect(page.locator(`[data-testid="settings-section-${section}"]`)).toBeVisible();
  }

  // Library rows keep exactly sync / change / remove; tag re-reading is gone.
  await expect(page.locator('[data-testid="settings-rescan-tags"]')).toHaveCount(0);
  const sourceRows = page.locator('[data-testid^="source-row-"]');
  await expect(sourceRows).toHaveCount(2);
  for (const row of await sourceRows.all()) {
    await expect(row.locator('button')).toHaveCount(3);
  }

  // Playback card: sleep timer plus the leveling and gapless toggles.
  await expect(page.locator('[data-testid="setting-leveling"]')).toBeVisible();
  await expect(page.locator('[data-testid="setting-gapless"]')).toBeVisible();
  await expect(page.locator('[data-testid="sleep-end"]')).toBeVisible();

  // The old inline settings card (and its spin toggle) is gone.
  await expect(page.locator('#vinyl-spin')).toHaveCount(0);

  // Build version is the 10-char source hash injected by the build.
  await expect(page.locator('[data-testid="about-version"]')).toHaveText(/^[0-9a-f]{10}$/);

  // The empty proxy field advertises the same-origin default.
  await expect(page.locator('[data-testid="setting-proxy-url"]')).toHaveAttribute(
    'placeholder',
    '/api/resolve',
  );

  // No audio responses are cached in a fresh profile: the toast still reports 0 B.
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('[data-testid="clear-cache"]').click();
  await expect(page.locator('.toast')).toContainText('0 B');

  // Language switch rebuilds the shell without leaving the settings view.
  await page.locator('[data-testid="language-en"]').click();
  await expect(page.locator('.settings-head h2')).toHaveText('Settings');
  await page.locator('[data-testid="settings-back"]').click();

  await expect(page.locator('[data-testid="settings-section-library"]')).toBeHidden();
  await expect(page.locator('#tab-folders')).toBeVisible();
  await expect(page.locator('#tab-folders')).toHaveText('Folders');
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');

  // Switch back to the configured Chinese locale for the remaining suite.
  await page.locator('[data-testid="settings-open"]').click();
  await page.locator('[data-testid="language-zh-CN"]').click();
  await expect(page.locator('.settings-head h2')).toHaveText('设置');
  await page.locator('[data-testid="settings-back"]').click();

  await expect(page.locator('[data-testid="settings-section-library"]')).toBeHidden();
  await expect(page.locator('#tab-folders')).toBeVisible();
  await expect(page.locator('#tab-folders')).toHaveText('文件夹');
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('zh-CN');
});
