import { expect, test } from '@playwright/test';

// Narrow phone viewport: the settings column must still use the full card
// width, with controls flush to the trailing edge and no squeezed segments.
test.use({ viewport: { width: 360, height: 780 } });

test('settings cards fill the width and controls hug the trailing edge', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-testid="settings-open"]').click();
  await expect(page.locator('[data-testid="settings-section-playback"]')).toBeVisible();

  const cards = await page.evaluate(() => {
    const visible = (node) => node.getClientRects().length > 0;
    return [...document.querySelectorAll('.settings-view .card.settings-card')]
      .filter(visible)
      .map((card) => {
        const rect = card.getBoundingClientRect();
        const style = getComputedStyle(card);
        const rights = [...card.querySelectorAll('button, input, select')]
          .filter(visible)
          .map((node) => node.getBoundingClientRect().right);
        return {
          testid: card.dataset.testid ?? '',
          right: rect.right,
          width: rect.width,
          paddingLeft: parseFloat(style.paddingLeft),
          paddingRight: parseFloat(style.paddingRight),
          maxRight: rights.length > 0 ? Math.max(...rights) : null,
        };
      });
  });

  expect(cards.length).toBeGreaterThan(0);

  for (const card of cards) {
    if (card.maxRight === null) continue;
    const slack = card.right - card.paddingRight - card.maxRight;
    expect(slack, `${card.testid || 'card'} control flush right`).toBeLessThanOrEqual(16.5);
    expect(slack, `${card.testid || 'card'} control inside content box`).toBeGreaterThanOrEqual(-0.5);
  }

  const languageCard = cards.find((card) => card.testid === 'settings-section-language');
  expect(languageCard).toBeTruthy();
  const segmented = await page
    .locator('[data-testid="settings-section-language"] .segmented')
    .boundingBox();
  expect(segmented).toBeTruthy();
  const contentWidth = languageCard.width - languageCard.paddingLeft - languageCard.paddingRight;
  expect(segmented.width).toBeGreaterThanOrEqual(0.9 * contentWidth);

  const leveling = page.locator('[data-testid="setting-leveling"]');
  const gapless = page.locator('[data-testid="setting-gapless"]');
  await expect(leveling).toBeVisible();
  await expect(gapless).toBeVisible();
  await expect(leveling).toHaveAttribute('role', 'switch');
  await expect(gapless).toHaveAttribute('role', 'switch');

  // The sleep select and both toggles share one line without overflowing.
  const playback = await page.evaluate(() => {
    const line = document.querySelector('[data-testid="playback-line"]');
    const settings = [...line.querySelectorAll('.inline-setting')];
    return {
      tops: settings.map((node) => node.offsetTop),
      overflow: line.scrollWidth - line.clientWidth,
    };
  });
  expect(playback.tops.length).toBe(3);
  expect(new Set(playback.tops).size).toBe(1);
  expect(playback.overflow, 'playback line horizontal overflow').toBeLessThanOrEqual(0);

  const storageOverflow = await page.evaluate(() => {
    const limit = document.querySelector('.storage-limit');
    return limit.scrollWidth - limit.clientWidth;
  });
  expect(storageOverflow, 'storage limit horizontal overflow').toBeLessThanOrEqual(0);

  // The compact source rows must not overflow a 360px phone viewport.
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="source-row-"]')].map((row) => ({
      id: row.dataset.testid,
      overflow: row.scrollWidth - row.clientWidth,
    })),
  );
  expect(rows.length).toBe(2);
  for (const row of rows) {
    expect(row.overflow, `${row.id} horizontal overflow`).toBeLessThanOrEqual(0);
  }
});
