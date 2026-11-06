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
  const languageList = page.locator('[data-testid="settings-section-language"] .language-list');
  await expect(languageList).toHaveAttribute('role', 'radiogroup');
  const languageListBox = await languageList.boundingBox();
  expect(languageListBox).toBeTruthy();
  const contentWidth = languageCard.width - languageCard.paddingLeft - languageCard.paddingRight;
  expect(languageListBox.width).toBeGreaterThanOrEqual(0.9 * contentWidth);

  const leveling = page.locator('[data-testid="setting-leveling"]');
  const gapless = page.locator('[data-testid="setting-gapless"]');
  await expect(leveling).toBeVisible();
  await expect(gapless).toBeVisible();
  await expect(leveling).toHaveAttribute('role', 'switch');
  await expect(gapless).toHaveAttribute('role', 'switch');

  // The sleep select and both toggles share one readable line: no label may
  // touch its control or the neighbour group, and the row must stay one line.
  // English has the longest labels, so both locales are measured.
  const measurePlayback = () =>
    page.evaluate(() => {
      const line = document.querySelector('[data-testid="playback-line"]');
      const lineRect = line.getBoundingClientRect();
      const groups = [...line.querySelectorAll('.inline-setting')].map((group) => {
        const label = group.querySelector('.inline-label');
        const control = group.querySelector('select, .toggle-switch');
        const labelRect = label.getBoundingClientRect();
        const controlRect = control.getBoundingClientRect();
        const groupRect = group.getBoundingClientRect();
        return {
          label: [labelRect.left, labelRect.right],
          control: [controlRect.left, controlRect.right],
          group: [groupRect.left, groupRect.right],
          vertical: [groupRect.top, groupRect.bottom],
        };
      });
      return {
        groupCount: groups.length,
        lineWidth: line.clientWidth,
        scrollWidth: line.scrollWidth,
        line: [lineRect.top, lineRect.bottom],
        lineHeight: lineRect.height,
        tallestGroup: Math.max(...groups.map((item) => item.vertical[1] - item.vertical[0])),
        groups,
      };
    });

  for (const locale of ['zh-CN', 'en']) {
    if (locale === 'en') {
      await page.locator('[data-testid="language-en"]').click();
      await expect(page.locator('[data-testid="playback-line"]')).toBeVisible();
    }
    for (const width of [360, 390]) {
      await page.setViewportSize({ width, height: 780 });
      await page.waitForTimeout(60);
      const layout = await measurePlayback();

      expect(layout.groupCount, `${locale} ${width}px playback groups`).toBe(3);
      expect(
        layout.scrollWidth,
        `${locale} ${width}px playback horizontal overflow`,
      ).toBeLessThanOrEqual(layout.lineWidth);
      // A single row: the line is as tall as its tallest control, not two rows.
      expect(layout.lineHeight, `${locale} ${width}px playback row height`).toBeLessThanOrEqual(
        layout.tallestGroup + 2,
      );

      for (const [index, item] of layout.groups.entries()) {
        expect(
          item.label[1],
          `${locale} ${width}px label ${index} overlaps its control`,
        ).toBeLessThanOrEqual(item.control[0] + 0.5);
        // A shrunken group must not let its label spill over the neighbour.
        expect(
          item.label[0],
          `${locale} ${width}px label ${index} spills left of its group`,
        ).toBeGreaterThanOrEqual(item.group[0] - 0.5);
        expect(
          item.label[1],
          `${locale} ${width}px label ${index} spills right of its group`,
        ).toBeLessThanOrEqual(item.group[1] + 0.5);
        const previousItem = layout.groups[index - 1];
        if (previousItem) {
          expect(
            previousItem.label[1],
            `${locale} ${width}px label ${index - 1} overlaps label ${index}`,
          ).toBeLessThanOrEqual(item.label[0] + 0.5);
        }
        expect(
          item.vertical[0],
          `${locale} ${width}px group ${index} starts above the row`,
        ).toBeGreaterThanOrEqual(layout.line[0] - 1);
        expect(
          item.vertical[1],
          `${locale} ${width}px group ${index} ends below the row`,
        ).toBeLessThanOrEqual(layout.line[1] + 1);

        const previous = layout.groups[index - 1];
        if (previous) {
          expect(
            previous.group[1],
            `${locale} ${width}px group ${index - 1} overlaps group ${index}`,
          ).toBeLessThanOrEqual(item.group[0] + 0.5);
        }
      }
    }
  }

  await page.setViewportSize({ width: 360, height: 780 });

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
  expect(rows.length).toBe(4);
  for (const row of rows) {
    expect(row.overflow, `${row.id} horizontal overflow`).toBeLessThanOrEqual(0);
  }
});
