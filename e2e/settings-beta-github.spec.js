import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { installGdriveMock } from './support/gdrive-mock.js';

const GITHUB_URL = 'https://github.com/SentimentalK/LocalTune';
const SHOTS = path.resolve('.scratch', 'conductor', 'au');
const CONTACT_NOTE =
  'Beta：只有测试名单里的账号能连接（联系 kevinxu.senti@gmail.com 加入）';

async function openSettings(page) {
  await page.goto('/');
  await expect(page.locator('.wordmark')).toHaveText('localtune.');
  await page.locator('[data-testid="settings-open"]').click();
  await expect(page.locator('[data-testid="settings-section-library"]')).toBeVisible();
}

test('Google Drive is marked Beta and carries the notice in its subtitle slot', async ({ page }) => {
  // Force the unconfigured build so the client-ID hint is present too: the
  // subtitle carries the notice while the configuration hint keeps its own line.
  await installGdriveMock(page, { clientId: '' });
  await openSettings(page);

  const row = page.locator('[data-testid="source-row-gdrive"]');
  await expect(row.locator('[data-testid="gdrive-beta"]')).toHaveText('Beta');
  await expect(row.locator('[data-testid="gdrive-beta-note"]')).toHaveCount(0);
  await expect(row.locator('.source-subtitle')).toHaveText(CONTACT_NOTE);
  await expect(row.locator('.source-subtitle')).toHaveAttribute(
    'href',
    'mailto:kevinxu.senti@gmail.com',
  );
  await expect(row.locator('[data-testid="gdrive-unconfigured"]')).toBeVisible();

  // Only Google Drive carries the badge and the contact copy.
  await expect(page.locator('.settings-view .source-badge')).toHaveCount(1);
  const notes = await page.evaluate(
    (note) =>
      [...document.querySelectorAll('.settings-view .source-subtitle')].filter(
        (node) => node.textContent === note,
      ).length,
    CONTACT_NOTE,
  );
  expect(notes).toBe(1);

  // The short connect button stays in the row; an unconfigured build only
  // disables it, and the full provider name stays on its accessible label.
  const connect = row.locator('[data-testid="source-connect-gdrive"]');
  await expect(connect).toBeVisible();
  await expect(connect).toBeDisabled();
  await expect(connect).toHaveText('连接');
  await expect(connect).toHaveAttribute('aria-label', '连接 Google Drive');
});

test('the GitHub link opens the repository from the left of the actions row', async ({ page }) => {
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

  const about = page.locator('[data-testid="settings-section-about"]');
  await expect(about.locator('.about-state')).toHaveCount(0);
  expect(await about.innerText()).not.toContain('最新');

  const layout = await page.evaluate(() => {
    const aboutNode = document.querySelector('[data-testid="settings-section-about"]');
    const github = document.querySelector('[data-testid="settings-github"]');
    const actions = github.parentElement;
    const githubRect = github.getBoundingClientRect();
    const githubCenter = githubRect.top + githubRect.height / 2;
    const siblings = ['check-update', 'settings-clear-data', 'playlog-open'].map((id) => {
      const rect = aboutNode.querySelector(`[data-testid="${id}"]`).getBoundingClientRect();
      return { center: rect.top + rect.height / 2, left: rect.left };
    });
    return {
      insideAbout: aboutNode.contains(actions),
      actionsClass: actions.className,
      first: actions.firstElementChild === github,
      centerDelta: Math.max(
        ...siblings.map((item) => Math.abs(item.center - githubCenter)),
      ),
      githubLeft: githubRect.left,
      siblingLeft: siblings[0].left,
      outsideRow: document.querySelectorAll(
        '.settings-view > [data-testid="settings-github"]',
      ).length,
    };
  });

  // One action row at the bottom of About, GitHub as its leftmost item.
  expect(layout.insideAbout).toBe(true);
  expect(layout.actionsClass).toContain('settings-actions');
  expect(layout.first).toBe(true);
  expect(layout.centerDelta).toBeLessThanOrEqual(2);
  expect(layout.githubLeft).toBeLessThan(layout.siblingLeft);
  expect(layout.outsideRow).toBe(0);
});

test('settings fit 360, 390 and 1280 with the Beta copy and actions row', async ({ page }) => {
  await openSettings(page);
  // Let the settings overlay finish sliding in before any resize: a viewport
  // change mid-transition leaves the panel in a half-laid-out state and makes
  // the captures depend on timing.
  await page.waitForTimeout(400);
  mkdirSync(SHOTS, { recursive: true });

  for (const [width, height] of [
    [390, 844],
    [360, 780],
    [1280, 800],
  ]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(200);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${width}px page overflow`).toBeLessThanOrEqual(0);

    const row = page.locator('[data-testid="source-row-gdrive"]');
    const rowOverflow = await row.evaluate((node) => node.scrollWidth - node.clientWidth);
    expect(rowOverflow, `${width}px Google Drive row overflow`).toBeLessThanOrEqual(0);

    await expect(row.locator('.source-subtitle')).toBeVisible();
    await expect(row.locator('.source-subtitle')).toHaveText(CONTACT_NOTE);
    await expect(row.locator('[data-testid="gdrive-beta"]')).toBeVisible();

    const actionTops = await page.evaluate(() => {
      const actions = document.querySelector('[data-testid="settings-section-about"] .settings-actions');
      return [...actions.children]
        .filter((node) => !node.hidden)
        .map((node) => Math.round(node.getBoundingClientRect().top));
    });
    expect(new Set(actionTops).size, `${width}px About actions share one row`).toBe(1);

    if (width === 1280) {
      // Two viewport shots: the library top proves the Beta subtitle and the
      // short connect buttons, About+language proves the pane's inset bar, the
      // single actions row and the language first line.
      await page.locator('[data-testid="settings-section-library"]').scrollIntoViewIfNeeded();
      await page.waitForTimeout(60);
      await expect(row.locator('.source-subtitle')).toBeVisible();
      await page.screenshot({ path: path.join(SHOTS, 'settings-1280.png') });

      await page.locator('[data-testid="settings-section-about"]').scrollIntoViewIfNeeded();
      await expect(page.locator('[data-testid="settings-github"]')).toBeVisible();
      await page.waitForTimeout(60);
      await page.screenshot({ path: path.join(SHOTS, 'settings-1280-about.png') });
      continue;
    }

    await page.locator('[data-testid="settings-section-about"]').scrollIntoViewIfNeeded();
    await expect(page.locator('[data-testid="settings-github"]')).toBeVisible();
    // The narrow shots need full page: the mobile layout scrolls the document,
    // so the whole settings flow must fit one capture.
    await page.screenshot({
      path: path.join(SHOTS, `settings-${width}.png`),
      fullPage: true,
    });
  }
});
