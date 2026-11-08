import { expect, test } from '@playwright/test';

/** Close glyphs the user can actually see in the top bar. */
const visibleXCount = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.top-actions .x-icon')].filter(
      (node) => getComputedStyle(node).display !== 'none',
    ).length,
  );

/** The desktop panel is out of the layout, not merely switched to the library. */
async function expectPanelClosed(page) {
  await expect
    .poll(() => page.evaluate(() => document.querySelector('.app').classList.contains('is-open')))
    .toBe(false);
  await expect(page.locator('#panel')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('#panel')).toBeHidden();
}

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

    // Clicking the active key closes the panel; it must not hand the slot to
    // the library view.
    await vipButton.click();
    await expect(vipButton.locator('.x-icon')).toBeHidden();
    await expect(vipButton).toHaveAttribute('aria-expanded', 'false');
    await expectPanelClosed(page);
    expect(await visibleXCount(page)).toBe(0);
  });

  test('desktop settings ✕ collapses without revealing the library', async ({ page }) => {
    await page.goto('/');

    const settingsButton = page.locator('[data-testid="settings-open"]');
    await settingsButton.click();
    await expect(page.locator('[data-testid="settings-section-playback"]')).toBeVisible();
    await expect(settingsButton).toHaveAttribute('aria-expanded', 'true');

    await settingsButton.click();
    await expect(settingsButton.locator('.x-icon')).toBeHidden();
    await expect(settingsButton).toHaveAttribute('aria-expanded', 'false');
    await expectPanelClosed(page);
    expect(await visibleXCount(page)).toBe(0);

    // The collapsed state is persisted: a reload must not reopen the panel.
    await page.reload();
    await expectPanelClosed(page);
    await expect(settingsButton).toHaveAttribute('aria-expanded', 'false');
  });

  test('desktop library ✕ collapses the open panel', async ({ page }) => {
    await page.goto('/');

    const panelButton = page.locator('[data-testid="panel-open"]');
    // A fresh desktop load starts with the library panel open.
    await expect(panelButton.locator('.x-icon')).toBeVisible();
    await expect(panelButton).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#tab-folders')).toBeVisible();

    await panelButton.click();
    await expect(panelButton.locator('.x-icon')).toBeHidden();
    await expect(panelButton).toHaveAttribute('aria-expanded', 'false');
    await expectPanelClosed(page);
    expect(await visibleXCount(page)).toBe(0);
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
