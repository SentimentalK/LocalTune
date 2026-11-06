import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { installGdriveMock } from './support/gdrive-mock.js';

async function connectAndPickMusic(page, mock) {
  await page.goto('/');
  await expect(page.locator('.wordmark')).toHaveText('localtune.');

  await page.locator('[data-testid="settings-open"]').click();
  await page.locator('[data-testid="source-connect-gdrive"]').click();

  await expect(page.locator('[data-testid="gdrive-picker"]')).toBeVisible();
  await expect(page.locator('[data-testid="gdrive-folder"]').first()).toHaveText('Music');
  await page.locator('[data-testid="gdrive-folder"]').first().click();
  await expect(page.locator('[data-testid="gdrive-picker-up"]')).toBeEnabled();
  await page.locator('[data-testid="gdrive-picker-choose"]').click();

  await expect(page.locator('[data-testid="gdrive-picker"]')).toBeHidden();
  await expect(page.locator('[data-testid="source-row-gdrive"]')).toContainText('2');
  await expect.poll(() => mock.mediaRequests.length, { timeout: 15_000 }).toBe(2);
  // The warm pass must be over before the spec starts playing or removing:
  // its progress line keeps its last text while hidden.
  await expect(page.locator('[data-testid="source-row-gdrive"] .settings-progress')).toBeHidden();
}

async function backToFolders(page) {
  await page.locator('[data-testid="panel-open"]').click();
  await expect(page.locator('#tab-folders')).toBeVisible();
}

async function expectPlaying(page) {
  await expect(page.locator('#armRotor')).toHaveAttribute('data-playing', 'true');
  await expect
    .poll(async () => page.locator('#armRotor').getAttribute('aria-valuenow'), { timeout: 10_000 })
    .not.toBe('0');
}

/** Replace the stored Drive token with an expired one, keeping root and rows. */
async function expireGdriveToken(page) {
  await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const open = indexedDB.open('localtune');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('meta', 'readwrite');
        tx.objectStore('meta').put({
          key: 'gdriveToken',
          value: {
            accessToken: 'expired-token',
            expiresAt: Date.now() - 60_000,
            scope: 'https://www.googleapis.com/auth/drive.readonly',
          },
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  });
}

test('Google Drive sync caches the files and playback downloads nothing', async ({ page }) => {
  test.setTimeout(120_000);
  const mock = await installGdriveMock(page);

  await connectAndPickMusic(page, mock);
  expect(mock.listRequests.length).toBeGreaterThan(0);
  expect(mock.listRequests.every((entry) => entry.authorization.startsWith('Bearer '))).toBe(true);
  expect(mock.tokenRequests).toBe(1);

  // `notes.txt` is not audio: only the two MP3s were indexed and cached.
  await backToFolders(page);
  await page.locator('[data-testid="folder-source-gdrive"]').click();
  await expect(page.locator('[data-testid="track-row"]')).toHaveCount(2);

  await page.locator('[data-testid="track-row"] .track').first().click();
  await expectPlaying(page);
  await page.waitForTimeout(300);
  expect(mock.mediaRequests).toHaveLength(2);

  await page.locator('[data-testid="settings-open"]').click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('[data-testid="settings-gdrive-remove"]').click();
  await expect(page.locator('[data-testid="source-row-gdrive"] .source-body span')).toContainText('0');

  await backToFolders(page);
  await expect(page.locator('[data-testid="folder-source-gdrive"]')).toHaveCount(0);
});

test('an expired Drive token keeps the cached library playable and reconnects', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const mock = await installGdriveMock(page);

  await connectAndPickMusic(page, mock);
  await expireGdriveToken(page);
  await page.reload();
  await expect(page.locator('.wordmark')).toHaveText('localtune.');

  const sourceRow = page.locator('[data-testid="folder-source-gdrive"]');
  await expect(sourceRow).toBeVisible();
  await expect(sourceRow).toContainText('2');

  await sourceRow.click();
  await expect(page.locator('[data-testid="track-row"]')).toHaveCount(2);
  const before = mock.mediaRequests.length;
  await page.locator('[data-testid="track-row"] .track').first().click();
  await expectPlaying(page);
  await page.waitForTimeout(300);
  expect(mock.mediaRequests).toHaveLength(before);

  await page.locator('[data-testid="settings-open"]').click();
  const change = page.locator('[data-testid="settings-source-gdrive"]');
  await expect(change).toHaveAttribute('aria-label', '重新连接');
  await expect(page.locator('[data-testid="source-row-gdrive"] .settings-error')).toContainText(
    '登录已过期',
  );

  const tokenBefore = mock.tokenRequests;
  await change.click();
  await expect(page.locator('[data-testid="gdrive-picker"]')).toBeVisible();
  expect(mock.tokenRequests).toBeGreaterThan(tokenBefore);

  await page.locator('[data-testid="gdrive-folder"]').first().click();
  await page.locator('[data-testid="gdrive-picker-choose"]').click();
  await expect(page.locator('[data-testid="gdrive-picker"]')).toBeHidden();
  await expect(page.locator('[data-testid="source-row-gdrive"]')).toContainText('2');
  await expect(page.locator('[data-testid="source-row-gdrive"] .settings-error')).toBeHidden();
});

test('an unconfigured build never touches the network', async ({ page }) => {
  test.setTimeout(120_000);
  const mock = await installGdriveMock(page, { clientId: '' });

  await page.goto('/');
  await expect(page.locator('.wordmark')).toHaveText('localtune.');
  await page.locator('[data-testid="settings-open"]').click();

  const hint = page.locator('[data-testid="gdrive-unconfigured"]');
  await expect(hint).toBeVisible();
  await expect(hint.locator('a')).toHaveAttribute(
    'href',
    'https://github.com/SentimentalK/LocalTune/blob/main/docs/oauth-setup.md',
  );
  await expect(page.locator('[data-testid="source-connect-gdrive"]')).toBeDisabled();
  await expect(page.locator('[data-testid="settings-sync-gdrive"]')).toBeHidden();

  await page.waitForTimeout(500);
  expect(mock.tokenRequests).toBe(0);
  expect(mock.listRequests).toHaveLength(0);
  expect(mock.mediaRequests).toHaveLength(0);

  const dir = path.resolve('.scratch', 'conductor', 'ah');
  mkdirSync(dir, { recursive: true });
  for (const [width, height, name] of [
    [360, 800, 'unconfigured-360.png'],
    [390, 844, 'unconfigured-390.png'],
  ]) {
    await page.setViewportSize({ width, height });
    await page.locator('[data-testid="settings-library-gdrive"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(dir, name), fullPage: true });
  }
});

test('a Drive 401 asks for a reconnect instead of failing silently', async ({ page }) => {
  test.setTimeout(120_000);
  const mock = await installGdriveMock(page);

  await connectAndPickMusic(page, mock);
  mock.reject401 = true;

  // Choosing the folder leaves the settings panel open: the sync button is
  // already reachable, and `settings-open` would toggle the panel shut.
  await page.locator('[data-testid="settings-sync-gdrive"]').click();

  const row = page.locator('[data-testid="source-row-gdrive"]');
  await expect(row.locator('.settings-error')).toContainText('登录已过期');
  await expect(page.locator('[data-testid="settings-source-gdrive"]')).toHaveAttribute(
    'aria-label',
    '重新连接',
  );
});
