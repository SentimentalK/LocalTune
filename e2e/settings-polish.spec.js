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

// The settings/VIP panes paint the library list's bar — same width, radius and
// colour, flush with the right edge — on a reserved gutter, so switching panes
// never shifts the content.
test('the settings pane paints the library bar on a reserved gutter', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openSettings(page);

  const bars = await page.evaluate(() => {
    const read = (node) => {
      const scrollbar = getComputedStyle(node, '::-webkit-scrollbar');
      const thumb = getComputedStyle(node, '::-webkit-scrollbar-thumb');
      return {
        width: Number.parseFloat(scrollbar.width),
        radius: thumb.borderTopLeftRadius,
        colour: thumb.backgroundColor,
        inset: Number.parseFloat(thumb.borderLeftWidth) || 0,
        clip: thumb.backgroundClip,
        gutter: getComputedStyle(node).scrollbarGutter,
        reserved: node.offsetWidth - node.clientWidth,
      };
    };
    return {
      list: read(document.querySelector('.list-scroll')),
      settings: read(document.querySelector('.settings-pane')),
    };
  });

  // One set of parameters for both surfaces: this is the whole point of the
  // change, so compare the settings bar against the list bar instead of
  // hard-coding 4px twice.
  expect(bars.list.width).toBe(4);
  expect(bars.settings.width).toBe(bars.list.width);
  expect(bars.settings.radius).toBe(bars.list.radius);
  expect(bars.settings.colour).toBe(bars.list.colour);
  expect(bars.settings.inset).toBe(0);
  expect(bars.settings.clip).toBe(bars.list.clip);
  expect(bars.settings.gutter).toBe('stable');
  // The gutter reserves exactly the bar, not a wider inset.
  expect(bars.settings.reserved).toBe(4);

  // Both panes reserve the same bar width, so the content box is the same size
  // in either one and switching cannot shift it.
  const visiblePane = () =>
    page.evaluate(() => {
      const pane = document.querySelector('.settings-pane:not([hidden]), .vip-pane:not([hidden])');
      return { clientWidth: pane.clientWidth, reserved: pane.offsetWidth - pane.clientWidth };
    });

  const settings = await visiblePane();
  await page.locator('[data-testid="vip-open"]').click();
  await expect(page.locator('#vipView')).toBeVisible();
  await page.waitForTimeout(600); // panel width transition

  const vip = await visiblePane();
  expect(vip.reserved).toBe(4);
  expect(vip.clientWidth).toBe(settings.clientWidth);
});
