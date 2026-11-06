import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { installDropboxMock } from './support/dropbox-mock.js';

async function connectAndPickMusic(page, mock) {
  await page.goto('/');
  await expect(page.locator('.wordmark')).toHaveText('localtune.');

  await page.locator('[data-testid="settings-open"]').click();
  await page.locator('[data-testid="source-connect-dropbox"]').click();

  await expect(page.locator('[data-testid="dropbox-picker"]')).toBeVisible();
  await expect(page.locator('[data-testid="dropbox-folder"]').first()).toHaveText('Music');
  await page.locator('[data-testid="dropbox-folder"]').first().click();
  await expect(page.locator('[data-testid="dropbox-picker-choose"]')).toBeEnabled();
  await page.locator('[data-testid="dropbox-picker-choose"]').click();

  await expect(page.locator('[data-testid="dropbox-picker"]')).toBeHidden();
  await expect(page.locator('[data-testid="source-row-dropbox"]')).toContainText('2');
  await expect.poll(() => mock.mediaRequests.length, { timeout: 15_000 }).toBe(2);
  // The warm pass must be over before the spec starts playing or removing:
  // its progress line keeps its last text while hidden.
  await expect(page.locator('[data-testid="source-row-dropbox"] .settings-progress')).toBeHidden();
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

/** Replace the stored Dropbox token with an expired one, keeping root and rows. */
async function expireDropboxToken(page) {
  await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const open = indexedDB.open('localtune');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('meta', 'readwrite');
        tx.objectStore('meta').put({
          key: 'dropboxToken',
          value: {
            accessToken: 'expired-token',
            refreshToken: 'dbx-refresh-1',
            expiresAt: Date.now() - 60_000,
            scope: 'files.metadata.read files.content.read',
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

test('Dropbox connect, browse, scan, cached playback and disconnect', async ({ page }) => {
  test.setTimeout(120_000);
  const mock = await installDropboxMock(page);

  await connectAndPickMusic(page, mock);

  const apiRequests = [...mock.listRequests, ...mock.mediaRequests];
  expect(apiRequests.length).toBeGreaterThan(0);
  expect(apiRequests.every((entry) => entry.authorization === 'Bearer dbx-access-1')).toBe(true);

  const authRequest = mock.tokenRequests.find((entry) => entry.grant === 'authorization_code');
  expect(authRequest.body.code).toBe('mock-code');
  expect(Boolean(authRequest.body.code_verifier)).toBe(true);
  expect(JSON.stringify(authRequest.body)).not.toContain('client_secret');
  expect(new URL(mock.authorizeUrls[0]).searchParams.get('token_access_type')).toBe('offline');

  await backToFolders(page);
  await page.locator('[data-testid="folder-source-dropbox"]').click();
  await expect(page.locator('[data-testid="track-row"]')).toHaveCount(2);

  await page.locator('[data-testid="track-row"] .track').first().click();
  await expectPlaying(page);
  await page.waitForTimeout(300);
  expect(mock.mediaRequests).toHaveLength(2);

  await page.locator('[data-testid="settings-open"]').click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('[data-testid="settings-dropbox-remove"]').click();
  await expect(
    page.locator('[data-testid="source-row-dropbox"] .source-subtitle'),
  ).toHaveText('连接 Dropbox 音乐目录');
  await expect(page.locator('[data-testid="source-row-dropbox"] .source-count')).toBeHidden();

  await backToFolders(page);
  await expect(page.locator('[data-testid="folder-source-dropbox"]')).toHaveCount(0);
});

test('a 401 triggers one silent refresh and a retried listing', async ({ page }) => {
  test.setTimeout(120_000);
  const mock = await installDropboxMock(page);

  await connectAndPickMusic(page, mock);
  mock.reject401 = 'once';

  await page.locator('[data-testid="settings-sync-dropbox"]').click();

  await expect
    .poll(() => mock.tokenRequests.filter((entry) => entry.grant === 'refresh_token').length, {
      timeout: 15_000,
    })
    .toBe(1);
  await expect
    .poll(() => mock.listRequests.at(-1)?.authorization, { timeout: 15_000 })
    .toBe('Bearer dbx-access-2');
  await expect(page.locator('[data-testid="source-row-dropbox"]')).toContainText('2');
  await expect(page.locator('[data-testid="source-row-dropbox"] .settings-error')).toBeHidden();
});

test('a dead refresh token keeps cached audio playable and asks to reconnect', async ({ page }) => {
  test.setTimeout(120_000);
  const mock = await installDropboxMock(page);

  await connectAndPickMusic(page, mock);
  await expireDropboxToken(page);
  mock.refreshOk = false;
  await page.reload();
  await expect(page.locator('.wordmark')).toHaveText('localtune.');

  const sourceRow = page.locator('[data-testid="folder-source-dropbox"]');
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
  await expect(page.locator('[data-testid="source-row-dropbox"] .settings-error')).toContainText(
    '登录已过期',
  );
  await expect(page.locator('[data-testid="settings-source-dropbox"]')).toHaveAttribute(
    'aria-label',
    '重新连接',
  );
});

test('an unconfigured Dropbox build never touches the network', async ({ page }) => {
  test.setTimeout(120_000);
  const mock = await installDropboxMock(page, { appKey: '' });

  await page.goto('/');
  await expect(page.locator('.wordmark')).toHaveText('localtune.');
  await page.locator('[data-testid="settings-open"]').click();

  const hint = page.locator('[data-testid="dropbox-unconfigured"]');
  await expect(hint).toBeVisible();
  await expect(hint.locator('a')).toHaveAttribute(
    'href',
    'https://github.com/SentimentalK/LocalTune/blob/main/docs/oauth-setup.md',
  );
  await expect(page.locator('[data-testid="source-connect-dropbox"]')).toBeDisabled();
  await expect(page.locator('[data-testid="settings-sync-dropbox"]')).toBeHidden();

  await page.waitForTimeout(500);
  expect(mock.authorizeUrls).toHaveLength(0);
  expect(mock.tokenRequests).toHaveLength(0);
  expect(mock.listRequests).toHaveLength(0);
  expect(mock.mediaRequests).toHaveLength(0);

  const dir = path.resolve('.scratch', 'conductor', 'ai');
  mkdirSync(dir, { recursive: true });
  for (const [width, height, name] of [
    [360, 800, 'dropbox-unconfigured-360.png'],
    [390, 844, 'dropbox-unconfigured-390.png'],
  ]) {
    await page.setViewportSize({ width, height });
    await page.locator('[data-testid="settings-library-dropbox"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(dir, name), fullPage: true });
  }
});

test('a non-ASCII Dropbox path downloads and caches without a header error', async ({ page }) => {
  test.setTimeout(120_000);
  const remote = '/Music/Joker Xue - 像风一样.mp3';
  const mock = await installDropboxMock(page, {
    files: [{ id: 'id-cn', name: 'Joker Xue - 像风一样.mp3', path: remote }],
    pageSize: 10,
  });

  await page.goto('/');
  await expect(page.locator('.wordmark')).toHaveText('localtune.');
  await page.locator('[data-testid="settings-open"]').click();
  await page.locator('[data-testid="source-connect-dropbox"]').click();
  await expect(page.locator('[data-testid="dropbox-picker"]')).toBeVisible();
  await expect(page.locator('[data-testid="dropbox-folder"]').first()).toHaveText('Music');
  await page.locator('[data-testid="dropbox-folder"]').first().click();
  await expect(page.locator('[data-testid="dropbox-picker-choose"]')).toBeEnabled();
  await page.locator('[data-testid="dropbox-picker-choose"]').click();
  await expect(page.locator('[data-testid="dropbox-picker"]')).toBeHidden();

  // The warm pass reads the only file. Before the fix the fetch threw on the
  // non-ISO-8859-1 header, so this request never reached the mock.
  await expect.poll(() => mock.mediaRequests.length, { timeout: 15_000 }).toBe(1);
  expect(mock.mediaRequests[0].path).toBe(remote);
  await expect(page.locator('[data-testid="source-row-dropbox"] .settings-error')).toBeHidden();
  await expect(page.locator('[data-testid="source-row-dropbox"] .settings-progress')).toBeHidden();

  await backToFolders(page);
  await page.locator('[data-testid="folder-source-dropbox"]').click();
  await expect(page.locator('[data-testid="track-row"]')).toHaveCount(1);
  await page.locator('[data-testid="track-row"] .track').first().click();
  await expectPlaying(page);
  await page.waitForTimeout(300);
  expect(mock.mediaRequests).toHaveLength(1); // played from the cache, no second download
});
