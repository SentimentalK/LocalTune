import { expect, test } from '@playwright/test';

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function contrastRatio(colorA, colorB) {
  const parse = (value) => value.match(/[\d.]+/g).slice(0, 3).map(Number);
  const luminance = (rgb) => {
    const [r, g, b] = rgb.map((channel) => {
      const c = channel / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [light, dark] = [luminance(parse(colorA)), luminance(parse(colorB))].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

test.describe('background guide dialog', () => {
  test.use({ userAgent: ANDROID_UA, locale: 'en-US' });

  async function openGuide(page) {
    await page.goto('/');
    await page.locator('[data-testid="settings-open"]').click();
    await page.locator('[data-testid="battery-button"]').click();
    const dialog = page.locator('[data-testid="battery-dialog"]');
    await expect(dialog).toBeVisible();
    return dialog;
  }

  test('is a modal dialog focused on its title and closes with Escape', async ({ page }) => {
    const dialog = await openGuide(page);
    await expect(dialog).toHaveAttribute('role', 'dialog');
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog).toHaveAttribute('aria-labelledby', 'battery-dialog-title');
    await expect(page.locator('[data-testid="battery-dialog-title"]')).toBeFocused();
    await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');

    await expect(page.locator('[data-testid="battery-dialog-android"]')).toBeVisible();
    await expect(page.locator('[data-testid="battery-dialog-ios"]')).toBeHidden();
    await expect(dialog.locator('[data-testid="battery-dialog-android"] .guide-must')).toHaveCount(2);
    await expect(dialog.locator('[data-testid="battery-dialog-android"] .guide-should')).toHaveCount(2);
    await expect(dialog.locator('[data-testid="battery-dialog-android"] .guide-note')).toHaveCount(2);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.locator('[data-testid="battery-button"]')).toBeFocused();
    await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
  });

  test('closes on a backdrop click and keeps Tab inside the panel', async ({ page }) => {
    const dialog = await openGuide(page);
    for (let index = 0; index < 6; index += 1) await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => {
      const panel = document.querySelector('.battery-guide-panel');
      return panel.contains(document.activeElement);
    });
    expect(inside).toBe(true);
    await expect(dialog).toBeVisible();

    await page.mouse.click(4, 4);
    await expect(dialog).toBeHidden();
    await expect(page.locator('[data-testid="battery-button"]')).toBeFocused();
  });

  test('keeps red and amber text readable on the panel', async ({ page }) => {
    const dialog = await openGuide(page);
    const colors = await dialog.evaluate((node) => {
      const panel = node.querySelector('.battery-guide-panel');
      const read = (selector) => getComputedStyle(panel.querySelector(selector)).color;
      return {
        must: read('.guide-must'),
        should: read('.guide-should'),
        background: getComputedStyle(panel).backgroundColor,
      };
    });
    expect(contrastRatio(colors.must, colors.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.should, colors.background)).toBeGreaterThanOrEqual(4.5);
  });

  for (const width of [360, 390]) {
    test(`fits ${width}px without horizontal overflow`, async ({ page }) => {
      await page.setViewportSize({ width, height: 780 });
      const dialog = await openGuide(page);
      const overflow = await dialog.evaluate((node) => {
        const panel = node.querySelector('.battery-guide-panel');
        return {
          page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          panel: panel.scrollWidth - panel.clientWidth,
        };
      });
      expect(overflow.page).toBeLessThanOrEqual(0);
      expect(overflow.panel).toBeLessThanOrEqual(0);
      await expect(dialog.locator('.guide-must').first()).toBeVisible();
    });
  }

  test('shows no OEM brand names', async ({ page }) => {
    await openGuide(page);
    const text = await page.locator('[data-testid="battery-dialog"]').innerText();
    expect(text).not.toMatch(/Samsung|Xiaomi|Huawei|MIUI|One UI|EMUI|HyperOS|POCO|Redmi/);
  });
});

test.describe('iOS guide', () => {
  test.use({ userAgent: IOS_UA, locale: 'en-US' });

  test('opens the iOS section only', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-testid="settings-open"]').click();
    await page.locator('[data-testid="install-button"]').click();
    await expect(page.locator('[data-testid="battery-dialog-ios"]')).toBeVisible();
    await expect(page.locator('[data-testid="battery-dialog-android"]')).toBeHidden();
    await expect(page.locator('[data-testid="battery-dialog-title"]')).toBeFocused();
  });
});
