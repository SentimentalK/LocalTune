import { expect, test } from '@playwright/test';

test('the about card opens, copies and clears the playback log', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.wordmark')).toHaveText('localtune.');

  await page.locator('[data-testid="settings-open"]').click();
  const about = page.locator('[data-testid="settings-section-about"]');
  const open = about.locator('[data-testid="playlog-open"]');
  await expect(open).toBeVisible();
  await expect(about.locator('.settings-actions > *')).toHaveCount(6);
  // The update controls survive next to the log entry.
  await expect(about.locator('[data-testid="check-update"]')).toBeVisible();
  await expect(about.locator('[data-testid="settings-clear-data"]')).toBeVisible();
  await expect(about.locator('[data-testid="settings-reload"]')).toHaveCount(0);

  await open.click();
  const panel = page.locator('[data-testid="playlog-panel"]');
  await expect(panel).toBeVisible();
  const text = page.locator('[data-testid="playlog-text"]');
  await expect(text).toContainText('LocalTune play log');

  await panel.locator('[data-testid="playlog-copy"]').click();
  await expect(page.locator('.toast')).toContainText('已复制播放日志');

  await panel.locator('[data-testid="playlog-clear"]').click();
  await expect(text).toHaveText('');

  await panel.locator('[data-testid="playlog-close"]').click();
  await expect(panel).toHaveCount(0);
  await expect(about.locator('[data-testid="playlog-open"]')).toBeVisible();

  // Reopening after a clear starts empty and still shows the header line.
  await open.click();
  await expect(text).toContainText('LocalTune play log');
  await expect(text).not.toContainText('trackchange');
  await page.locator('[data-testid="playlog-panel"] [data-testid="playlog-close"]').click();
  await expect(page.locator('[data-testid="playlog-panel"]')).toHaveCount(0);
});
