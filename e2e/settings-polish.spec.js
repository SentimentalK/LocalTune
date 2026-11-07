import { expect, test } from '@playwright/test';
import { installGraphMock } from './support/graph-mock.js';
import { installGdriveMock } from './support/gdrive-mock.js';

const FILES = [
  { id: 'track-1', name: 'one.mp3' },
  { id: 'track-2', name: 'two.mp3' },
];

async function openSettings(page) {
  await page.goto('/');
  await expect(page.locator('.wordmark')).toHaveText('localtune.');
  await page.locator('[data-testid="settings-open"]').click();
  await expect(page.locator('[data-testid="source-row-local"]')).toBeVisible();
}

const horizontalOverflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

// The settings source icons follow the library's line icons: the path is a
// stroke glyph, so the base `.icon` fill:none/stroke rules must win.
test('the four source icons are outlined, not filled', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSettings(page);

  const icons = await page.evaluate(() =>
    [...document.querySelectorAll('.source-icon > svg.icon')].map((svg) => {
      const style = getComputedStyle(svg);
      return {
        fill: style.fill,
        stroke: style.stroke,
        strokeWidth: style.strokeWidth,
        color: style.color,
        size: Math.round(svg.getBoundingClientRect().width),
      };
    }),
  );

  expect(icons).toHaveLength(4);
  for (const icon of icons) {
    expect(icon.fill).toBe('none');
    expect(icon.stroke).toBe(icon.color);
    expect(icon.strokeWidth).toBe('2px');
    expect(icon.size).toBe(18);
  }
});

// The picker is a flat panel mounted inside the row that opened it: one copy,
// directly below that row's summary, and gone once it closes.
test('the picker opens flat inside the row that opened it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installGraphMock(page, { files: FILES });
  await installGdriveMock(page, { files: FILES });
  await openSettings(page);

  await page.locator('[data-testid="source-connect-onedrive"]').click();
  const picker = page.locator('[data-testid="onedrive-picker"]');
  await expect(picker).toBeVisible();

  expect(
    await picker.evaluate((node) => node.closest('[data-testid="source-row-onedrive"]')?.dataset.testid),
  ).toBe('source-row-onedrive');
  expect(
    await picker.evaluate(
      (node) =>
        node.parentElement.querySelector(':scope > .source-summary').getBoundingClientRect().bottom <=
        node.getBoundingClientRect().top,
    ),
  ).toBe(true);

  await expect(page.locator('.remote-picker')).toHaveCount(1);
  await expect(picker).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(picker).toHaveCSS('border-top-width', '0px');
  await expect(picker).toHaveCSS('border-top-left-radius', '0px');
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  // Opening another source moves the same panel; no stale copy stays behind.
  await page.locator('[data-testid="source-connect-gdrive"]').click();
  const gdrivePicker = page.locator('[data-testid="gdrive-picker"]');
  await expect(gdrivePicker).toBeVisible();
  await expect(page.locator('[data-testid="onedrive-picker"]')).toHaveCount(0);
  await expect(page.locator('.remote-picker')).toHaveCount(1);
  expect(
    await gdrivePicker.evaluate((node) => node.closest('[data-testid="source-row-gdrive"]')?.dataset.testid),
  ).toBe('source-row-gdrive');

  await page.locator('[data-testid="gdrive-picker-cancel"]').click();
  await expect(page.locator('.remote-picker')).toHaveCount(0);
  for (const kind of ['onedrive', 'gdrive', 'dropbox']) {
    await expect(page.locator(`[data-testid="${kind}-picker"]`)).toHaveCount(0);
  }
});

test('languages flow into a left-aligned grid without row separators', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSettings(page);

  const list = page.locator('[data-testid="settings-section-language"] .language-list');
  await expect(list).toHaveCSS('display', 'grid');

  const layout = await page.evaluate(() => {
    const list = document.querySelector('[data-testid="settings-section-language"] .language-list');
    const rows = [...list.querySelectorAll('.language-row')];
    const perRow = new Map();
    for (const row of rows) {
      const top = Math.round(row.getBoundingClientRect().top);
      perRow.set(top, (perRow.get(top) ?? 0) + 1);
    }
    return {
      count: rows.length,
      listLeft: list.getBoundingClientRect().left,
      firstColumnLeft: Math.min(...rows.map((row) => row.getBoundingClientRect().left)),
      maxPerRow: Math.max(...perRow.values()),
      borders: rows.map((row) => getComputedStyle(row).borderTopWidth),
    };
  });

  expect(layout.count).toBe(11);
  expect(layout.maxPerRow, 'language buttons sharing one row at 390px').toBeGreaterThanOrEqual(2);
  expect(Math.abs(layout.listLeft - layout.firstColumnLeft)).toBeLessThan(1);
  for (const border of layout.borders) expect(border).toBe('0px');

  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 780 });
    await page.waitForTimeout(80);
    expect(await horizontalOverflow(page), `${width}px horizontal overflow`).toBeLessThanOrEqual(0);
  }
});

// The settings scrollbar keeps the library list's 4px bar untouched, but its
// own bar is wider and paints a 4px thumb inset 3px from the panel edge.
test('the settings pane reserves an inset scrollbar gutter', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openSettings(page);

  const pane = page.locator('.settings-pane');
  await expect(pane).toHaveCSS('scrollbar-gutter', 'stable');

  const bar = await pane.evaluate((node) => {
    const scrollbar = getComputedStyle(node, '::-webkit-scrollbar');
    const thumb = getComputedStyle(node, '::-webkit-scrollbar-thumb');
    return {
      width: Number.parseFloat(scrollbar.width),
      inset: Number.parseFloat(thumb.borderLeftWidth),
      clip: thumb.backgroundClip,
      thumbColor: thumb.backgroundColor,
      reserved: node.offsetWidth - node.clientWidth,
    };
  });

  expect(bar.width).toBeGreaterThanOrEqual(8);
  expect(bar.width).toBeLessThanOrEqual(10);
  expect(bar.inset).toBeGreaterThanOrEqual(2);
  expect(bar.inset).toBeLessThanOrEqual(4);
  expect(bar.clip).toBe('content-box');
  expect(bar.width - bar.inset * 2).toBeGreaterThanOrEqual(2);
  expect(bar.thumbColor).not.toBe('rgba(0, 0, 0, 0)');
  expect(bar.reserved).toBe(bar.width);

  // The library list is out of scope and keeps its thin bar.
  const listBarWidth = await page.evaluate(
    () => Number.parseFloat(getComputedStyle(document.querySelector('.list-scroll'), '::-webkit-scrollbar').width),
  );
  expect(listBarWidth).toBe(4);
});
