// APP-001-T1: switching the OneDrive root must drop the old index rows and
// cached audio before the new folder is scanned, so the library never shows
// tracks of a folder the user left.
import { expect, test } from '@playwright/test';
import { installGraphMock } from './support/graph-mock.js';

const MUSIC = Array.from({ length: 100 }, (_, index) => ({
  id: `track-${index + 1}`,
  name: `one-${index + 1}.mp3`,
}));
const MUSIC2 = Array.from({ length: 5 }, (_, index) => ({
  id: `second-${index + 1}`,
  name: `two-${index + 1}.mp3`,
}));

async function readStore(page, name) {
  return page.evaluate(
    (storeName) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('localtune');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(storeName, 'readonly');
          const request = tx.objectStore(storeName).getAll();
          request.onsuccess = () => {
            db.close();
            resolve(request.result ?? []);
          };
          request.onerror = () => reject(request.error);
        };
      }),
    name,
  );
}

function onedriveCacheRows(rows) {
  return rows.filter((row) => row.source === 'onedrive');
}

test('changing the OneDrive folder drops the old index and cache', async ({ page }) => {
  test.setTimeout(240_000);
  await installGraphMock(page, {
    roots: [
      { id: 'folder-music', name: 'Music', files: MUSIC },
      { id: 'folder-music2', name: 'Music2', files: MUSIC2 },
    ],
  });

  await page.goto('/');
  await expect(page.locator('#app h1')).toHaveText('LocalTune');

  await page.locator('[data-testid="settings-open"]').click();
  await page.locator('[data-testid="source-connect-onedrive"]').click();

  const picker = page.locator('[data-testid="onedrive-picker"]');
  await expect(picker).toBeVisible();
  await page
    .locator('[data-testid="onedrive-folder"]')
    .filter({ hasText: /^Music$/ })
    .click();
  await page.locator('[data-testid="onedrive-picker-choose"]').click();
  await expect(picker).toBeHidden();

  // Wait for the first folder's scan and cache warm to settle.
  await expect
    .poll(async () => onedriveCacheRows(await readStore(page, 'cacheIndex')).length, {
      timeout: 120_000,
    })
    .toBe(MUSIC.length);

  // Switch to the second folder through the pencil button.
  await page.locator('[data-testid="settings-source-onedrive"]').click();
  await expect(picker).toBeVisible();
  await page
    .locator('[data-testid="onedrive-folder"]')
    .filter({ hasText: /^Music2$/ })
    .click();
  await page.locator('[data-testid="onedrive-picker-choose"]').click();
  await expect(picker).toBeHidden();

  await expect
    .poll(async () => (await readStore(page, 'tracks')).filter((row) => row.source === 'onedrive').length, {
      timeout: 120_000,
    })
    .toBe(MUSIC2.length);
  await expect
    .poll(async () => onedriveCacheRows(await readStore(page, 'cacheIndex')).length, {
      timeout: 120_000,
    })
    .toBe(MUSIC2.length);

  const cacheIndex = onedriveCacheRows(await readStore(page, 'cacheIndex'));
  expect(cacheIndex).toHaveLength(MUSIC2.length);
  const cachedPaths = cacheIndex.map((row) => row.path).sort();
  expect(cachedPaths).toEqual(MUSIC2.map((file) => file.name).sort());
  expect(cacheIndex.filter((row) => String(row.path).startsWith('one-'))).toHaveLength(0);

  const tracks = (await readStore(page, 'tracks')).filter((row) => row.source === 'onedrive');
  expect(tracks.map((row) => row.path).sort()).toEqual(MUSIC2.map((file) => file.name).sort());

  await expect(page.locator('[data-testid="source-row-onedrive"]')).toContainText('5');
});
