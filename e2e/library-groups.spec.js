import { expect, test } from '@playwright/test';

test('library shows a local group before the cloud group', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-testid="settings-open"]').click();

  const local = page.locator('[data-testid="settings-library-local"]');
  const cloud = page.locator('[data-testid="settings-library-cloud"]');
  await expect(local).toBeVisible();
  await expect(cloud).toBeVisible();
  await expect(local.locator('.source-title')).toHaveText('本地文件夹');
  await expect(cloud.locator('.source-title')).toHaveText('OneDrive');
  await expect(local.locator('[data-testid="source-row-local"]')).toBeVisible();
  await expect(cloud.locator('[data-testid="source-row-onedrive"]')).toBeVisible();

  const localFirst = await page.evaluate(() => {
    const a = document.querySelector('[data-testid="settings-library-local"]');
    const b = document.querySelector('[data-testid="settings-library-cloud"]');
    return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(localFirst).toBe(true);

  await expect(page.locator('[data-testid="source-connect-onedrive"]')).toHaveText('连接 OneDrive');
  await expect(page.locator('[data-testid="source-connect-local"]')).toHaveText('选择本地文件夹');
});
