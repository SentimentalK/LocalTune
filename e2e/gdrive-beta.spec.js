import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { installGdriveMock } from './support/gdrive-mock.js';

const SHOTS = path.resolve('.scratch', 'conductor', 'be');
const CONTACT = 'kevinxu.senti@gmail.com';
const WARNING = `Beta：只有测试名单里的账号能连接（联系 ${CONTACT} 加入）`;

async function openSettings(page) {
  await page.goto('/');
  await expect(page.locator('.wordmark')).toHaveText('localtune.');
  await page.locator('[data-testid="settings-open"]').click();
  await expect(page.locator('[data-testid="settings-section-library"]')).toBeVisible();
}

async function screenshot(page, width, height, name) {
  mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width, height });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(80);
  await page.screenshot({ path: path.join(SHOTS, name), fullPage: true });
}

test('the disconnected Drive row carries the amber beta notice as its subtitle', async ({ page }) => {
  await installGdriveMock(page, { betaAck: true });
  await openSettings(page);

  const row = page.locator('[data-testid="source-row-gdrive"]');
  const subtitle = row.locator('.source-subtitle');
  await expect(subtitle).toBeVisible();
  await expect(subtitle).toHaveText(WARNING);
  await expect(subtitle).toHaveAccessibleName(WARNING);
  // The subtitle slot itself is the link, not a plain span with a second line
  // underneath.
  expect(await subtitle.evaluate((node) => node.tagName)).toBe('A');
  await expect(subtitle).toHaveAttribute('href', `mailto:${CONTACT}`);
  // Amber (--warn), not the red used for failures.
  await expect(subtitle).toHaveCSS('color', 'rgb(214, 180, 122)');
  await expect(row.locator('[data-testid="gdrive-beta"]')).toHaveText('Beta');

  // Exactly one line carries the notice: no betaNote duplicate anywhere.
  expect(
    await page.evaluate(
      (text) =>
        [...document.querySelectorAll('.settings-view *')].filter(
          (node) => node.children.length === 0 && node.textContent === text,
        ).length,
      WARNING,
    ),
  ).toBe(1);

  await screenshot(page, 390, 844, 'warning-390.png');
  await screenshot(page, 1280, 900, 'warning-1280.png');
});

test('the first connect shows the confirmation once and remembers it', async ({ page }) => {
  test.setTimeout(120_000);
  await installGdriveMock(page, { betaAck: false });
  await openSettings(page);

  await page.locator('[data-testid="source-connect-gdrive"]').click();
  const confirm = page.locator('[data-testid="gdrive-beta-confirm"]');
  await expect(confirm).toBeVisible();
  await expect(page.locator('[data-testid="gdrive-picker"]')).toHaveCount(0);
  await expect(confirm.locator('.gdrive-beta-confirm-text')).toHaveCSS(
    'color',
    'rgb(214, 180, 122)',
  );
  expect(
    await page.evaluate(() => localStorage.getItem('localtune:gdriveBetaAck')),
  ).toBeNull();

  await screenshot(page, 390, 844, 'confirm-390.png');
  await screenshot(page, 1280, 900, 'confirm-1280.png');

  await page.locator('[data-testid="gdrive-beta-confirm-yes"]').click();
  await expect(page.locator('[data-testid="gdrive-picker"]')).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem('localtune:gdriveBetaAck')),
  ).toBe('v1');

  // Connected: the subtitle is the folder name and nothing else.
  await page.locator('[data-testid="gdrive-folder"]').first().click();
  await page.locator('[data-testid="gdrive-picker-choose"]').click();
  await expect(page.locator('[data-testid="gdrive-picker"]')).toBeHidden();
  const row = page.locator('[data-testid="source-row-gdrive"]');
  await expect(row.locator('.source-subtitle')).toHaveText('Music');
  await expect(row.locator('.source-subtitle')).not.toHaveAttribute('href', /mailto/);
  await expect(row.locator('.source-subtitle')).not.toHaveClass(/is-beta/);
  await expect(row.locator('.source-subtitle')).not.toHaveText(WARNING);

  await screenshot(page, 390, 844, 'connected-390.png');
  await screenshot(page, 1280, 900, 'connected-1280.png');

  // A reload plus a fresh (forgotten) source must go straight to the popup.
  await page.reload();
  await expect(page.locator('.wordmark')).toHaveText('localtune.');
  await page.locator('[data-testid="settings-open"]').click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('[data-testid="settings-gdrive-remove"]').click();
  await expect(page.locator('[data-testid="source-connect-gdrive"]')).toBeVisible();
  await page.locator('[data-testid="source-connect-gdrive"]').click();
  await expect(page.locator('[data-testid="gdrive-picker"]')).toBeVisible();
  await expect(confirm).toBeHidden();
});

test('access_denied becomes an actionable red block with the contact copy', async ({ page }) => {
  test.setTimeout(120_000);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await installGdriveMock(page, { betaAck: true, oauthError: 'access_denied' });
  await openSettings(page);

  await page.locator('[data-testid="source-connect-gdrive"]').click();

  const row = page.locator('[data-testid="source-row-gdrive"]');
  const block = row.locator('.settings-error-block');
  await expect(block).toHaveClass(/is-failure/);
  await expect(block).toBeVisible();
  await expect(row.locator('.settings-error')).toContainText('不在测试名单');
  await expect(row.locator('.settings-error')).toContainText(CONTACT);
  await expect(row.locator('.settings-error')).toHaveCSS('color', 'rgb(217, 139, 132)');
  // Still disconnected: the amber notice keeps showing above the failure.
  await expect(row.locator('.source-subtitle')).toHaveText(WARNING);

  const copy = page.locator('[data-testid="gdrive-copy-account"]');
  await expect(copy).toBeVisible();
  await expect(copy).toHaveText('复制联系地址');

  await screenshot(page, 390, 844, 'failure-390.png');
  await screenshot(page, 1280, 900, 'failure-1280.png');

  await copy.click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(CONTACT);
});
