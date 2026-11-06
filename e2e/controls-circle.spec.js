import { expect, test } from '@playwright/test';
import { openSeededLibrary } from './support/seed.js';

// The vinyl stage replaces the old five-key transport row. On the tightest
// phone width the deck, title and the two mode keys must still fit, and the
// arm must remain a usable, visible target.
const WIDTHS = [320, 360, 390, 430];

for (const width of WIDTHS) {
  test(`the vinyl stage fits at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openSeededLibrary(page);

    await expect(page.locator('#armRotor')).toHaveAttribute('data-playing', 'true');
    await expect(page.locator('.controls')).toHaveCount(0);
    await expect(page.locator('.progress')).toHaveCount(0);

    const modes = page.locator('.now .mode');
    await expect(modes).toHaveCount(2);
    await expect(page.locator('.deck')).not.toHaveClass(/swapping/);
    const boxes = await modes.evaluateAll((nodes) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }),
    );
    for (const box of boxes) {
      expect(Math.abs(box.width - box.height)).toBeLessThanOrEqual(1);
      expect(box.width).toBeGreaterThan(36);
    }

    const disc = await page.locator('.vinyl').boundingBox();
    expect(disc).not.toBeNull();
    expect(Math.abs(disc.x + disc.width / 2 - width / 2)).toBeLessThanOrEqual(2);
    const arm = await page.locator('.arm-rest-knob').boundingBox();
    expect(arm).not.toBeNull();
    expect(arm.x + arm.width).toBeLessThanOrEqual(width - 2);

    const layout = await page.evaluate(() => {
      const song = document.querySelector('.song').getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        songRight: song.right,
      };
    });
    expect(layout.overflow).toBeLessThanOrEqual(0);
    expect(layout.songRight).toBeLessThanOrEqual(width);

    await page.screenshot({ path: `test-results/stage-${width}.png` });
  });
}
