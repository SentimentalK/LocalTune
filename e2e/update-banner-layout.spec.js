// The update pill must stay on one line at phone widths. The banner exists in
// the DOM from boot but stays hidden until a service worker update is waiting;
// revealing it here isolates the layout from the update flow that
// e2e/update.spec.js already covers.

import { expect, test } from '@playwright/test';

const PHONE_WIDTHS = [320, 360, 390];
const LOCALE = 'de-DE'; // longest update.available / update.apply strings

async function revealBanner(page) {
  await page.goto('/');
  const banner = page.locator('.update-banner');
  await banner.waitFor({ state: 'attached' });
  await page.evaluate(() => {
    document.querySelector('.update-banner').hidden = false;
  });
}

async function measure(page) {
  return page.evaluate(() => {
    const banner = document.querySelector('.update-banner');
    const span = banner.querySelector('span');
    const rect = banner.getBoundingClientRect();
    const spanRect = span.getBoundingClientRect();
    return {
      text: span.textContent,
      rectCount: span.getClientRects().length,
      spanHeight: spanRect.height,
      lineHeight: Number.parseFloat(getComputedStyle(span).lineHeight),
      bannerLeft: rect.left,
      bannerRight: rect.right,
      bannerCenter: (rect.left + rect.right) / 2,
      spanScrollWidth: span.scrollWidth,
      spanClientWidth: span.clientWidth,
      docScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  });
}

for (const width of PHONE_WIDTHS) {
  test.describe(`${width}px viewport`, () => {
    test.use({ viewport: { width, height: 720 }, locale: LOCALE });

    test('keeps the update banner on one line inside the viewport', async ({ page }) => {
      await revealBanner(page);
      const m = await measure(page);

      // A flex-item span is always one box, so the height against line-height
      // is what actually rules out wrapping.
      expect(m.rectCount).toBe(1);
      expect(m.spanHeight, m.text).toBeLessThanOrEqual(m.lineHeight + 1);

      expect(m.bannerLeft).toBeGreaterThanOrEqual(0);
      expect(m.bannerRight).toBeLessThanOrEqual(m.innerWidth);
      expect(m.spanScrollWidth).toBeLessThanOrEqual(m.spanClientWidth + 1);
      expect(m.docScrollWidth).toBeLessThanOrEqual(m.innerWidth);
    });
  });
}

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, locale: LOCALE });

  test('keeps the update banner centred on one line', async ({ page }) => {
    await revealBanner(page);
    const m = await measure(page);

    expect(m.rectCount).toBe(1);
    expect(m.spanHeight, m.text).toBeLessThanOrEqual(m.lineHeight + 1);
    expect(Math.abs(m.bannerCenter - m.innerWidth / 2)).toBeLessThanOrEqual(1);
    expect(m.spanScrollWidth).toBeLessThanOrEqual(m.spanClientWidth + 1);
  });
});
