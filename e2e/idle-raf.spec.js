import { expect, test } from '@playwright/test';

// The tonearm used to renew `requestAnimationFrame` unconditionally, so an
// idle deck burned task time forever. Counting requests proves the loop is
// asleep at rest and awake only while audio plays.

test('the deck requests frames only while playing', async ({ page }) => {
  await page.addInitScript(() => {
    window.__raf = 0;
    const native = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => {
      window.__raf += 1;
      return native(callback);
    };
  });

  await page.goto('/');
  await expect(page.locator('.deck')).toBeVisible();

  await page.waitForTimeout(5_000);
  expect(await page.evaluate(() => window.__raf)).toBe(0);

  await page.locator('.arm-head-hit').click();
  await expect(page.locator('#armRotor')).toHaveAttribute('data-playing', 'true');
  await page.waitForTimeout(1_000);
  expect(await page.evaluate(() => window.__raf)).toBeGreaterThanOrEqual(10);

  await page.locator('.arm-head-hit').click({ force: true });
  await expect(page.locator('#armRotor')).toHaveAttribute('data-playing', 'false');
  await page.waitForTimeout(1_000);
  const paused = await page.evaluate(() => window.__raf);
  await page.waitForTimeout(2_000);
  expect(await page.evaluate(() => window.__raf)).toBe(paused);
});
