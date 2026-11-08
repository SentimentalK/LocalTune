import { expect, test } from '@playwright/test';

// The appearance card is the only place that lists every palette; the header
// palette button stays as the one-tap cycle. Both must agree, and the choice
// must survive a reload (index.html restores it before paint).

const SWATCH = '[data-testid^="theme-"][role="radio"]';

async function openAppearance(page) {
  await page.goto('/');
  await page.locator('[data-testid="settings-open"]').click();
  await expect(page.locator('[data-testid="settings-section-theme"]')).toBeVisible();
}

test('the appearance card lists every theme and marks the active one', async ({ page }) => {
  await openAppearance(page);

  const swatches = page.locator(SWATCH);
  await expect(swatches).toHaveCount(10);
  await expect(page.locator(`${SWATCH}[aria-checked="true"]`)).toHaveCount(1);
  await expect(page.locator('[data-testid="theme-blue"]')).toHaveAttribute('aria-checked', 'true');

  // Each square previews its own palette: the disc paints the theme background.
  const preview = await page.locator('[data-testid="theme-obsidian"] .theme-swatch-disc').evaluate(
    (node) => getComputedStyle(node).getPropertyValue('--swatch-bg').trim(),
  );
  expect(preview).toBe('#0a0a0b');
});

test('picking a swatch applies and persists the theme', async ({ page }) => {
  await openAppearance(page);

  await page.locator('[data-testid="theme-aubergine"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'aubergine');
  await expect(page.locator('[data-testid="theme-aubergine"]')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.locator('[data-testid="theme-blue"]')).toHaveAttribute('aria-checked', 'false');
  expect(await page.evaluate(() => localStorage.getItem('localtune-theme'))).toBe('aubergine');
  // The status-bar colour follows the canvas.
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#100e14');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'aubergine');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(16, 14, 20)');
});

test('the header palette button keeps cycling, in sync with the swatches', async ({ page }) => {
  await openAppearance(page);
  await page.locator('[data-testid="theme-obsidian"]').click();

  // Cycle order follows the list the card renders.
  await page.locator('[data-testid="theme-toggle"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'aubergine');
  await expect(page.locator('[data-testid="theme-aubergine"]')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.locator('[data-testid="theme-toggle"]')).toHaveAttribute(
    'aria-label',
    /Aubergine/,
  );
});

test('the status-bar colour follows the canvas on every theme switch', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAppearance(page);

  // The manifest values are frozen at install time; only this meta tag can
  // track the palette at runtime, so it must change in the same frame as the
  // canvas and match it exactly (no tolerance).
  for (const [theme, hex] of [
    ['obsidian', '#0a0a0b'],
    ['aubergine', '#100e14'],
  ]) {
    await page.locator(`[data-testid="theme-${theme}"]`).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

    const state = await page.evaluate(() => {
      const [r, g, b] = getComputedStyle(document.documentElement)
        .backgroundColor.match(/\d+/g)
        .slice(0, 3)
        .map(Number);
      const channel = (value) => value.toString(16).padStart(2, '0');
      return {
        meta: document.querySelector('meta[name="theme-color"]')?.content ?? null,
        canvas: `#${channel(r)}${channel(g)}${channel(b)}`,
      };
    });

    expect(state.canvas).toBe(hex);
    expect(state.meta).toBe(state.canvas);
  }
});

test('the swatch grid is one tab stop and arrows select', async ({ page }) => {
  await openAppearance(page);

  await page.locator('[data-testid="theme-obsidian"]').click();
  const active = page.locator('[data-testid="theme-obsidian"]');
  await expect(active).toHaveAttribute('tabindex', '0');
  await expect(page.locator('[data-testid="theme-graphite"]')).toHaveAttribute('tabindex', '-1');

  await active.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'aubergine');
  await expect(page.locator('[data-testid="theme-aubergine"]')).toHaveAttribute('tabindex', '0');

  // The ends hold focus instead of wrapping.
  await page.keyboard.press('End');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'sage');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'sage');
});

test('the swatch grid fits a phone without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAppearance(page);

  const card = await page.locator('[data-testid="settings-section-theme"]').boundingBox();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  const swatches = await page.locator(SWATCH).evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top };
    }),
  );
  // Ten palettes, five per row: each swatch stays inside the card.
  expect(new Set(swatches.map((box) => Math.round(box.top))).size).toBe(2);
  for (const box of swatches) {
    expect(box.left).toBeGreaterThanOrEqual(card.x - 0.5);
    expect(box.right).toBeLessThanOrEqual(card.x + card.width + 0.5);
  }

  // Names wrap; they never run past their column.
  const overflow = await page
    .locator('[data-testid="settings-section-theme"] .theme-swatch-name')
    .evaluateAll((nodes) => nodes.filter((node) => node.scrollWidth > node.clientWidth + 1).length);
  expect(overflow).toBe(0);
});
