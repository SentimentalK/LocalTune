import { expect, test } from '@playwright/test';

test('settings view covers library, storage, language and about', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#app h1')).toHaveText('LocalTune');

  await page.locator('[data-testid="settings-open"]').click();

  for (const section of ['library', 'storage', 'playback', 'language', 'about']) {
    await expect(page.locator(`[data-testid="settings-section-${section}"]`)).toBeVisible();
  }

  // Library rows show one connect button until a source is connected; the
  // sync / change / remove icons appear only for a connected source.
  await expect(page.locator('[data-testid="settings-rescan-tags"]')).toHaveCount(0);
  const sourceRows = page.locator('[data-testid^="source-row-"]');
  await expect(sourceRows).toHaveCount(2);
  for (const row of await sourceRows.all()) {
    await expect(row.locator('button')).toHaveCount(1);
  }
  await expect(page.locator('[data-testid="source-connect-local"]')).toBeVisible();
  await expect(page.locator('[data-testid="source-connect-onedrive"]')).toBeVisible();
  await expect(page.locator('[data-testid="settings-sync-local"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="settings-sync-onedrive"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="settings-source-change"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="settings-source-remove"]')).toHaveCount(0);

  // Playback card: one line with the sleep timer select and the two toggles.
  await expect(page.locator('[data-testid="playback-line"]')).toBeVisible();
  await expect(page.locator('[data-testid="sleep-timer"]')).toHaveValue('off');
  await expect(page.locator('[data-testid="setting-leveling"]')).toBeVisible();
  await expect(page.locator('[data-testid="setting-gapless"]')).toBeVisible();

  // The old inline settings card (and its spin toggle) is gone.
  await expect(page.locator('#vinyl-spin')).toHaveCount(0);

  // Build version is the 10-char source hash injected by the build.
  await expect(page.locator('[data-testid="about-version"]')).toHaveText(/^[0-9a-f]{10}$/);

  // Playlist resolving inputs moved out of the about card into VIP.
  const aboutCard = page.locator('[data-testid="settings-section-about"]');
  await expect(aboutCard.locator('[data-testid="setting-youtube-key"]')).toHaveCount(0);
  await expect(aboutCard.locator('[data-testid="setting-proxy-url"]')).toHaveCount(0);
  await expect(aboutCard.locator('.settings-actions > *')).toHaveCount(3);

  // The storage card has a single clear action; a fresh profile clears to 0 B.
  const cachedMusic = page.locator('[data-testid="storage-audio"] b');
  await expect(cachedMusic).toHaveText('0 B');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('[data-testid="clear-all"]').click();
  await expect(page.locator('.toast')).toContainText('已清空');
  await expect(cachedMusic).toHaveText('0 B');

  // Language switch rebuilds the shell without leaving the settings view.
  await page.locator('[data-testid="language-en"]').click();
  await page.locator('[data-testid="settings-close"]').click();

  await expect(page.locator('[data-testid="settings-section-library"]')).toBeHidden();
  await expect(page.locator('#tab-folders')).toBeVisible();
  await expect(page.locator('#tab-folders')).toHaveText('Folders');
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');

  // Switch back to the configured Chinese locale for the remaining suite.
  await page.locator('[data-testid="settings-open"]').click();
  await page.locator('[data-testid="language-zh-CN"]').click();
  await page.locator('[data-testid="settings-close"]').click();

  await expect(page.locator('[data-testid="settings-section-library"]')).toBeHidden();
  await expect(page.locator('#tab-folders')).toBeVisible();
  await expect(page.locator('#tab-folders')).toHaveText('文件夹');
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('zh-CN');

  // Playlist resolving settings sit at the bottom of the VIP view.
  await page.locator('[data-testid="vip-open"]').click();
  await expect(page.locator('[data-testid="vip-playlist-settings"]')).toBeVisible();
  await expect(page.locator('[data-testid="setting-proxy-url"]')).toHaveAttribute(
    'placeholder',
    '/api/resolve',
  );
  await expect(page.locator('[data-testid="setting-youtube-key"]')).toBeVisible();
  await page.locator('[data-testid="settings-close"]').click();

  await expect(page.locator('#tab-folders')).toBeVisible();
  await expect(page.locator('[data-testid="vip-playlist-settings"]')).toBeHidden();
});
