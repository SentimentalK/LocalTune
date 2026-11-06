import { expect, test } from '@playwright/test';
import { installGraphMock } from './support/graph-mock.js';

const FILES = [
  { id: 'track-1', name: 'one.mp3' },
  { id: 'track-2', name: 'two.mp3' },
];

async function readPlayLogRows(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('localtune');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('playlog', 'readonly');
          const request = tx.objectStore('playlog').getAll();
          request.onsuccess = () => {
            db.close();
            resolve(request.result ?? []);
          };
          request.onerror = () => reject(request.error);
        };
      }),
  );
}

async function signInAndPickMusic(page, mock) {
  await page.goto('/');
  await expect(page.locator('.wordmark')).toHaveText('localtune.');

  await page.locator('[data-testid="settings-open"]').click();
  await page.locator('[data-testid="source-connect-onedrive"]').click();

  await expect(page.locator('[data-testid="onedrive-picker"]')).toBeVisible();
  await expect(page.locator('[data-testid="onedrive-folder"]').first()).toHaveText('Music');
  await page.locator('[data-testid="onedrive-folder"]').first().click();
  await page.locator('[data-testid="onedrive-picker-choose"]').click();

  await expect(page.locator('[data-testid="onedrive-picker"]')).toBeHidden();
  await expect.poll(() => mock.wholeRequests.length, { timeout: 10_000 }).toBe(2);
}

/** Replace the stored token with an expired grant, keeping root and tracks. */
async function expireToken(page) {
  await page.evaluate(async () => {
    const now = Date.now();
    await new Promise((resolve, reject) => {
      const open = indexedDB.open('localtune');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('meta', 'readwrite');
        const store = tx.objectStore('meta');
        store.put({
          key: 'onedriveToken',
          value: {
            accessToken: 'expired',
            refreshToken: '',
            expiresAt: now - 60_000,
            scope: 'Files.Read',
          },
        });
        // Startup silent reauth guard: keep the page from redirecting away.
        store.put({ key: 'onedriveSilent', value: { at: now } });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  });
}

test('expired OneDrive token keeps the cached library visible and playable', async ({ page }) => {
  test.setTimeout(120_000);
  const mock = await installGraphMock(page, { files: FILES });

  await signInAndPickMusic(page, mock);
  await expireToken(page);
  await page.reload();
  await expect(page.locator('.wordmark')).toHaveText('localtune.');

  const sourceRow = page.locator('[data-testid="folder-source-onedrive"]');
  await expect(sourceRow).toBeVisible();
  await expect(sourceRow).toContainText('2');
  await expect(page.locator('[data-testid^="source-hint-"]')).toHaveCount(0);
  await expect(page.locator('[data-testid^="source-reconnect-"]')).toHaveCount(0);
  await expect(page.locator('[data-testid^="folder-reconnect-"]')).toHaveCount(0);
  // The header error box is a permanent (hidden) placeholder node, so assert
  // on visibility: an empty hidden box never surfaces login state.
  await expect(page.locator('.app > .alert[role="alert"]')).toBeHidden();
  await expect(page.locator('[data-testid="folder-empty"]')).toHaveCount(0);

  await sourceRow.click();
  await expect(page.locator('[data-testid="track-row"]')).toHaveCount(2);

  const before = mock.wholeRequests.length;
  await page.locator('[data-testid="track-row"] .track').first().click();
  await expect(page.locator('#armRotor')).toHaveAttribute('data-playing', 'true');
  await expect
    .poll(async () => page.locator('#armRotor').getAttribute('aria-valuenow'), { timeout: 10_000 })
    .not.toBe('0');
  await page.waitForTimeout(300);
  expect(mock.wholeRequests.length).toBe(before);

  const authorizeBefore = mock.authorizeRequests.length;
  await page.locator('[data-testid="settings-open"]').click();
  const row = page.locator('[data-testid="source-row-onedrive"]');
  await expect(row.locator('button')).toHaveCount(3);
  const change = page.locator('[data-testid="settings-source-onedrive"]');
  await expect(change).toHaveAttribute('aria-label', '更换文件夹');
  await expect(page.locator('[data-testid="source-connect-onedrive"]')).toBeHidden();
  await expect(page.locator('[data-testid^="source-hint-"]')).toHaveCount(0);

  await change.click();
  await expect(page.locator('[data-testid="onedrive-picker"]')).toBeVisible();
  expect(mock.authorizeRequests.length).toBeGreaterThan(authorizeBefore);
});

test('uncached tracks fail quietly and land in the play log', async ({ page }) => {
  test.setTimeout(120_000);
  const mock = await installGraphMock(page, { files: FILES });

  await signInAndPickMusic(page, mock);
  await expireToken(page);
  await page.reload();
  await expect(page.locator('.wordmark')).toHaveText('localtune.');

  await page.evaluate(() => caches.delete('audio-v1'));
  await page.reload();
  await expect(page.locator('.wordmark')).toHaveText('localtune.');

  const before = mock.wholeRequests.length;
  await page.locator('[data-testid="folder-source-onedrive"]').click();
  await expect(page.locator('[data-testid="track-row"]')).toHaveCount(2);

  await page.locator('[data-testid="track-row"] .track').first().click();
  await expect(page.locator('#armRotor')).toHaveAttribute('data-playing', 'false');
  // The header error box is a permanent (hidden) placeholder node, so assert
  // on visibility: an empty hidden box never surfaces login state.
  await expect(page.locator('.app > .alert[role="alert"]')).toBeHidden();
  await expect(page.locator('[data-testid^="source-hint-"]')).toHaveCount(0);

  const rows = await readPlayLogRows(page);
  expect(rows.some((row) => row.type === 'loadfail')).toBe(true);

  await page.waitForTimeout(300);
  expect(mock.wholeRequests.length).toBe(before);
});
