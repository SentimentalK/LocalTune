import { expect, test } from '@playwright/test';

// Narrow-phone transport row: every control must share the play button's
// centre line, the row must fit without horizontal overflow, and the active
// repeat control must read as the same solid accent button as play.

async function layout(page) {
  await page.goto('/');
  await expect(page.locator('#app h1')).toBeVisible();

  const controls = page.locator('.controls');
  const buttons = controls.locator('.btn');
  await expect(buttons).toHaveCount(5);

  const boxes = [];
  for (let index = 0; index < 5; index += 1) {
    const box = await buttons.nth(index).boundingBox();
    expect(box).not.toBeNull();
    boxes.push(box);
  }

  const mainCenterY = boxes[2].y + boxes[2].height / 2;
  for (const index of [0, 1, 3, 4]) {
    const centerY = boxes[index].y + boxes[index].height / 2;
    expect(Math.abs(centerY - mainCenterY)).toBeLessThanOrEqual(1);
  }

  const controlsBox = await controls.boundingBox();
  const { width, height, scrollWidth } = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(controlsBox.x).toBeGreaterThanOrEqual(0);
  expect(controlsBox.y).toBeGreaterThanOrEqual(0);
  expect(controlsBox.x + controlsBox.width).toBeLessThanOrEqual(width);
  expect(controlsBox.y + controlsBox.height).toBeLessThanOrEqual(height);
  expect(scrollWidth).toBeLessThanOrEqual(width);

  // Resolve theme colours through a probe; never pin hex values here.
  const theme = await page.evaluate(() => {
    const rgb = (value) => {
      const probe = document.createElement('span');
      probe.style.color = value.trim();
      document.body.append(probe);
      const out = getComputedStyle(probe).color;
      probe.remove();
      return out;
    };
    const root = getComputedStyle(document.documentElement);
    return {
      accent: rgb(root.getPropertyValue('--accent')),
      accentFg: rgb(root.getPropertyValue('--accent-fg')),
      surface: rgb(root.getPropertyValue('--surface')),
    };
  });

  const repeat = page.locator('[data-testid="control-repeat"]');
  await repeat.click();
  await expect(repeat).toHaveAttribute('aria-pressed', 'true');
  // `.btn` transitions `color` over 120 ms; poll until it reaches the target.
  await expect(repeat).toHaveCSS('color', theme.accentFg);

  const background = (selector) =>
    page.evaluate(
      (target) => getComputedStyle(document.querySelector(target)).backgroundColor,
      selector,
    );
  expect(await background('[data-testid="control-repeat"]')).toBe(theme.accent);
  expect(await background('[data-testid="control-shuffle"]')).toBe(theme.surface);
  expect(theme.surface).not.toBe(theme.accent);
}

test.describe('transport row at 390x844', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('controls align, fit, and show the accent when active', async ({ page }) => {
    await layout(page);
    await page.screenshot({ path: 'test-results/transport-390.png' });
  });
});

test.describe('transport row at 360x780', () => {
  test.use({ viewport: { width: 360, height: 780 } });

  test('controls align, fit, and show the accent when active', async ({ page }) => {
    await layout(page);
    await page.screenshot({ path: 'test-results/transport-360.png' });
  });
});
