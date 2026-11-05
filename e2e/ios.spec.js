import { expect, test } from '@playwright/test';

const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

test.describe('ios', () => {
  test.use({ userAgent: IOS_UA, locale: 'en-US' });

  test('iOS meta tags and the iOS guide section are present', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute(
      'content',
      'yes',
    );

    await page.locator('[data-testid="settings-open"]').click();
    const install = page.locator('[data-testid="install-button"]');
    await expect(install).toHaveText('How to install');
    await expect(page.locator('[data-testid="battery-button"]')).toHaveText('Check settings');

    await install.click();
    const dialog = page.locator('[data-testid="battery-dialog"]');
    await expect(dialog).toBeVisible();
    await expect(page.locator('[data-testid="battery-dialog-ios"]')).toBeVisible();
    await expect(page.locator('[data-testid="battery-dialog-android"]')).toBeHidden();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});

test.describe('desktop', () => {
  test('the platform buttons stay hidden', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-testid="settings-open"]').click();
    await expect(page.locator('[data-testid="install-button"]')).toBeHidden();
    await expect(page.locator('[data-testid="battery-button"]')).toBeHidden();
    await expect(page.locator('[data-testid="battery-dialog"]')).toHaveCount(0);
  });
});
