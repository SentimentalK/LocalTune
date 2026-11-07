import { expect, test } from '@playwright/test';

// The cover is its own composited layer (will-change: transform + the spin
// animation). WebKit can drop an ancestor's rounded overflow clip for such a
// layer, which showed the square artwork on iPhone, so the cover must clip
// itself. The ancestor keeps its overflow clip as a second line of defence.
const WIDTHS = [1280, 390];

for (const width of WIDTHS) {
  test(`the spinning cover clips itself to the disc at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto('/');

    const cover = page.locator('#cover');
    await expect(cover).toBeVisible();

    const state = await page.evaluate(() => {
      const cover = document.querySelector('#cover');
      const vinyl = document.querySelector('.vinyl');
      const coverStyle = getComputedStyle(cover);
      const vinylStyle = getComputedStyle(vinyl);
      const box = vinyl.getBoundingClientRect();
      const hit = (x, y) => {
        const node = document.elementFromPoint(x, y);
        return node?.id || node?.className || '';
      };
      const inset = 4;
      return {
        clipPath: coverStyle.clipPath,
        animation: coverStyle.animationName,
        willChange: coverStyle.willChange,
        overflow: vinylStyle.overflow,
        radius: vinylStyle.borderRadius,
        corners: [
          hit(box.left + inset, box.top + inset),
          hit(box.right - inset, box.top + inset),
          hit(box.left + inset, box.bottom - inset),
          hit(box.right - inset, box.bottom - inset),
        ],
      };
    });

    expect(state.clipPath).toMatch(/^circle\(/);
    expect(state.animation).toBe('spin');
    expect(state.willChange).toBe('transform');
    expect(state.overflow).toBe('hidden');
    expect(state.radius).toBe('50%');
    for (const corner of state.corners) expect(corner).not.toBe('cover');
  });
}
