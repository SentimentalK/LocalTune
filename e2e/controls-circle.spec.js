import { expect, test } from '@playwright/test';

// The five transport keys must stay perfect circles in the player card, and
// the row must fit without horizontal scrolling, on every phone width the app
// targets. 320px is the tightest case: the card is 252px wide inside it.
const WIDTHS = [320, 360, 390, 430];

for (const width of WIDTHS) {
  test(`the five transport keys are circles at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');

    const keys = page.locator('.controls .btn');
    await expect(keys).toHaveCount(5);
    await expect(keys.first()).toBeVisible();

    const boxes = await keys.evaluateAll((nodes) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }),
    );
    expect(boxes).toHaveLength(5);
    for (const box of boxes) {
      // Sub-pixel layout rounding is allowed; a shrunken flex item is not.
      expect(Math.abs(box.width - box.height)).toBeLessThanOrEqual(1);
      expect(box.width).toBeGreaterThan(36);
    }

    const layout = await page.evaluate(() => {
      const row = document.querySelector('.controls').getBoundingClientRect();
      const card = document.querySelector('.player').getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        row: row.width,
        card: card.width,
      };
    });
    expect(layout.overflow).toBeLessThanOrEqual(0);
    expect(layout.row).toBeLessThanOrEqual(layout.card);

    await page.screenshot({ path: `test-results/controls-${width}.png` });
  });
}
