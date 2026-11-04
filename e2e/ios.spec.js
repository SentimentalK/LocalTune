import { expect, test } from '@playwright/test';

const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

test.describe('ios', () => {
  test.use({ userAgent: IOS_UA });

  test('iOS meta tags and install guide are present', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute(
      'content',
      'yes',
    );

    await page.locator('[data-testid="settings-open"]').click();
    const guide = page.locator('[data-testid="ios-install-guide"]');
    await expect(guide).toBeVisible();
    for (const step of ['ios-step-1', 'ios-step-2', 'ios-step-3']) {
      await expect(page.locator(`[data-testid="${step}"]`)).toHaveCount(1);
    }

    // The Android-only battery entry is present but hidden on iOS; its
    // rendering logic must stay untouched.
    await expect(page.locator('[data-testid="battery-button"]')).toBeHidden();
  });
});

test.describe('desktop', () => {
  test('iOS install guide stays hidden', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-testid="settings-open"]').click();
    await expect(page.locator('[data-testid="ios-install-guide"]')).toBeHidden();
  });
});
