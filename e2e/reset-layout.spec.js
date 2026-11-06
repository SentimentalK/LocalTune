import { expect, test } from '@playwright/test';
import { installGraphMock } from './support/graph-mock.js';

// Touch-sized source actions and a wordmark that clears the top action row.
test.use({ viewport: { width: 360, height: 780 } });

async function connectSource(page) {
  await installGraphMock(page);
  await page.goto('/');
  await page.locator('[data-testid="settings-open"]').click();
  await page.locator('[data-testid="source-connect-onedrive"]').click();
  await expect(page.locator('[data-testid="onedrive-picker"]')).toBeVisible();
  await page.locator('[data-testid="onedrive-folder"]').first().click();
  await page.locator('[data-testid="onedrive-picker-choose"]').click();
  await expect(page.locator('[data-testid="source-row-onedrive"]')).toContainText('2');
}

function measure(page) {
  return page.evaluate(() => {
    const row = document.querySelector('[data-testid="source-row-onedrive"]');
    const buttons = [...row.querySelectorAll('.icon-action')];
    const summary = row.querySelector('.source-summary');
    const group = row.querySelector('.source-actions-icons');
    const wordmark = document.querySelector('.wordmark').getBoundingClientRect();
    const brand = document.querySelector('.brand-group').getBoundingClientRect();
    const topActions = document.querySelector('.top-actions').getBoundingClientRect();
    return {
      count: buttons.length,
      sizes: buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }),
      gap: parseFloat(getComputedStyle(group).columnGap),
      svg: getComputedStyle(buttons[0].querySelector('svg')).width,
      overflow: summary.scrollWidth - summary.clientWidth,
      wordmarkRight: wordmark.right,
      brandRight: brand.right,
      topActionsLeft: topActions.left,
    };
  });
}

test('source actions and the wordmark fit 360px and 390px', async ({ page }) => {
  await connectSource(page);

  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: width === 360 ? 780 : 844 });
    await page.waitForTimeout(80);
    const layout = await measure(page);

    expect(layout.count, `${width}px icon actions`).toBe(3);
    for (const size of layout.sizes) {
      expect(size.width, `${width}px action width`).toBe(44);
      expect(size.height, `${width}px action height`).toBe(44);
    }
    expect(layout.gap, `${width}px action gap`).toBe(12);
    expect(layout.svg, `${width}px action glyph`).toBe('20px');
    expect(layout.overflow, `${width}px source summary overflow`).toBeLessThanOrEqual(1);
    expect(
      layout.wordmarkRight,
      `${width}px wordmark clears the top actions`,
    ).toBeLessThanOrEqual(layout.topActionsLeft - 4);
    expect(
      layout.brandRight,
      `${width}px wordmark and status clear the top actions`,
    ).toBeLessThanOrEqual(layout.topActionsLeft - 4);
  }
});
