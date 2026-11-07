import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { installGdriveMock } from './support/gdrive-mock.js';

const GITHUB_URL = 'https://github.com/SentimentalK/LocalTune';
const SHOTS = path.resolve('.scratch', 'conductor', 'ap');

async function openSettings(page) {
  await page.goto('/');
  await expect(page.locator('.wordmark')).toHaveText('localtune.');
  await page.locator('[data-testid="settings-open"]').click();
  await expect(page.locator('[data-testid="settings-section-library"]')).toBeVisible();
}

test('Google Drive is marked Beta with a fixed contact note', async ({ page }) => {
  // Force the unconfigured build so the Beta note and the client-ID hint are
  // both present: the note must not replace that hint.
  await installGdriveMock(page, { clientId: '' });
  await openSettings(page);

  const row = page.locator('[data-testid="source-row-gdrive"]');
  await expect(row.locator('[data-testid="gdrive-beta"]')).toHaveText('Beta');
  await expect(row.locator('[data-testid="gdrive-beta-note"]')).toHaveText('想连接请联系作者');
  await expect(row.locator('[data-testid="gdrive-unconfigured"]')).toBeVisible();
  await expect(row).toContainText('Beta');

  // The connect button stays in the row; an unconfigured build only disables
  // it, exactly as before.
  await expect(row.locator('[data-testid="source-connect-gdrive"]')).toBeVisible();
  await expect(row.locator('[data-testid="source-connect-gdrive"]')).toBeDisabled();

  // The note renders above the configuration hint.
  const order = await row.evaluate((node) => {
    const note = node.querySelector('[data-testid="gdrive-beta-note"]');
    const hint = node.querySelector('[data-testid="gdrive-unconfigured"]');
    return { note: Boolean(note), hint: Boolean(hint), followsHint: note?.nextElementSibling === hint };
  });
  expect(order).toEqual({ note: true, hint: true, followsHint: true });

  // Scoped to Google Drive: no other source carries the badge or note.
  await expect(page.locator('.settings-view .source-badge')).toHaveCount(1);
  await expect(page.locator('[data-testid="gdrive-beta-note"]')).toHaveCount(1);
});

test('the GitHub footer link opens the repository in a new tab', async ({ page }) => {
  await openSettings(page);

  const link = page.locator('[data-testid="settings-github"]');
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', GITHUB_URL);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /\bnoopener\b/);
  await expect(link).toHaveAttribute('rel', /\bnoreferrer\b/);
  await expect(link).toContainText('GitHub');

  const icon = link.locator('svg.icon');
  await expect(icon).toHaveCount(1);
  await expect(icon.locator('path')).toHaveAttribute('d', /^M15 22v-4a4\.8/);
  await expect(icon).toHaveCSS('width', '16px');
  await expect(icon).toHaveCSS('height', '16px');

  const layout = await page.evaluate(() => {
    const about = document.querySelector('[data-testid="settings-section-about"]');
    const github = document.querySelector('[data-testid="settings-github"]');
    const view = document.querySelector('.settings-view');
    const aboutRect = about.getBoundingClientRect();
    const linkRect = github.getBoundingClientRect();
    return {
      gap: linkRect.top - aboutRect.bottom,
      left: linkRect.left,
      viewLeft: view.getBoundingClientRect().left,
      aboutTop: aboutRect.top,
    };
  });
  // Directly after About, 20–28px below it and left aligned with the column.
  expect(layout.gap).toBeGreaterThanOrEqual(20);
  expect(layout.gap).toBeLessThanOrEqual(28);
  expect(Math.abs(layout.left - layout.viewLeft)).toBeLessThanOrEqual(1);
});

test('settings fit 360, 390 and 1280 with the Beta copy and footer', async ({ page }) => {
  await openSettings(page);
  mkdirSync(SHOTS, { recursive: true });

  for (const [width, height] of [
    [390, 844],
    [360, 780],
    [1280, 800],
  ]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(80);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${width}px page overflow`).toBeLessThanOrEqual(0);

    const rowOverflow = await page
      .locator('[data-testid="source-row-gdrive"]')
      .evaluate((node) => node.scrollWidth - node.clientWidth);
    expect(rowOverflow, `${width}px Google Drive row overflow`).toBeLessThanOrEqual(0);

    await expect(page.locator('[data-testid="gdrive-beta"]')).toBeVisible();
    await expect(page.locator('[data-testid="gdrive-beta-note"]')).toBeVisible();

    await page.locator('[data-testid="settings-github"]').scrollIntoViewIfNeeded();
    await expect(page.locator('[data-testid="settings-github"]')).toBeVisible();
    await page.screenshot({
      path: path.join(SHOTS, `settings-${width}.png`),
      fullPage: true,
    });
  }
});
