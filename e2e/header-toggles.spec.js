import { expect, test } from '@playwright/test';

/** Close glyphs the user can actually see in the top bar. */
const visibleXCount = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.top-actions .x-icon')].filter(
      (node) => getComputedStyle(node).display !== 'none',
    ).length,
  );

test.describe('desktop header toggles', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('desktop toggles swap the close glyph', async ({ page }) => {
    await page.goto('/');

    const settingsButton = page.locator('[data-testid="settings-open"]');
    const vipButton = page.locator('[data-testid="vip-open"]');
    const panelButton = page.locator('[data-testid="panel-open"]');

    await settingsButton.click();
    await expect(settingsButton.locator('.x-icon')).toBeVisible();
    await expect(settingsButton.locator('.own-icon')).toBeHidden();
    await expect(settingsButton).toHaveAttribute('aria-expanded', 'true');
    await expect(vipButton.locator('.x-icon')).toBeHidden();
    await expect(panelButton.locator('.x-icon')).toBeHidden();
    await expect(page.locator('#panel')).toBeVisible();

    await vipButton.click();
    await expect(vipButton.locator('.x-icon')).toBeVisible();
    await expect(settingsButton.locator('.x-icon')).toBeHidden();
    await expect(settingsButton.locator('.own-icon')).toBeVisible();
    await expect(vipButton).toHaveAttribute('aria-expanded', 'true');
    await expect(settingsButton).toHaveAttribute('aria-expanded', 'false');
    expect(await visibleXCount(page)).toBe(1);

    await vipButton.click();
    await expect(page.locator('#tab-folders')).toBeVisible();
    await expect(vipButton.locator('.x-icon')).toBeHidden();
    await expect(settingsButton).toHaveAttribute('aria-expanded', 'false');
    expect(await visibleXCount(page)).toBeLessThanOrEqual(1);
  });
});

test.describe('mobile header toggles', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('mobile close collapses the overlay', async ({ page }) => {
    await page.goto('/');

    const settingsButton = page.locator('[data-testid="settings-open"]');
    const vipButton = page.locator('[data-testid="vip-open"]');

    await settingsButton.click();
    await expect(settingsButton.locator('.x-icon')).toBeVisible();
    await expect(settingsButton).toHaveAttribute('aria-expanded', 'true');
    await expect
      .poll(() => page.evaluate(() => document.body.classList.contains('overlay-open')))
      .toBe(true);
    expect(await visibleXCount(page)).toBe(1);

    await vipButton.click();
    await expect(vipButton.locator('.x-icon')).toBeVisible();
    await expect(settingsButton.locator('.x-icon')).toBeHidden();
    await expect(vipButton).toHaveAttribute('aria-expanded', 'true');
    await expect(settingsButton).toHaveAttribute('aria-expanded', 'false');
    expect(await visibleXCount(page)).toBe(1);

    await vipButton.click();
    await expect
      .poll(() => page.evaluate(() => document.body.classList.contains('overlay-open')))
      .toBe(false);
    await expect
      .poll(() => page.evaluate(() => document.querySelector('.app').classList.contains('is-overlay')))
      .toBe(false);
    await expect(page.locator('#panel')).toBeVisible();
    await expect(vipButton.locator('.x-icon')).toBeHidden();
    await expect(settingsButton).toHaveAttribute('aria-expanded', 'false');
    expect(await visibleXCount(page)).toBe(0);
  });
});
