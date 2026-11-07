import { expect, test } from '@playwright/test';
import { installGraphMock } from './support/graph-mock.js';

test('clearing all data returns the app to its first launch state', async ({ page }) => {
  await installGraphMock(page);
  await page.goto('/');

  // One connected source, so the library and the caches both hold data.
  await page.locator('[data-testid="settings-open"]').click();
  await page.locator('[data-testid="source-connect-onedrive"]').click();
  await expect(page.locator('[data-testid="onedrive-picker"]')).toBeVisible();
  await page.locator('[data-testid="onedrive-folder"]').first().click();
  await page.locator('[data-testid="onedrive-picker-choose"]').click();
  await expect(page.locator('[data-testid="source-row-onedrive"]')).toContainText('2');

  await page.evaluate(() => {
    localStorage.setItem('localtune-theme', 'forest');
    localStorage.setItem('localtune-library-tab', 'folders');
  });
  expect(await page.evaluate(() => localStorage.length)).toBeGreaterThan(0);

  // The service worker precaches on install; wait for that before wiping.
  await expect
    .poll(() => page.evaluate(() => caches.keys().then((keys) => keys.length)))
    .toBeGreaterThan(0);

  // Sentinel inside the live database: it can only disappear if the whole
  // database was deleted, not merely cleared by one store.
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('localtune');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('meta', 'readwrite');
          tx.objectStore('meta').put({ key: 'e2eResetSentinel', value: 1 });
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );

  // Recorded at document-start of the reloaded page: an unregistered worker
  // means no controller when the fresh document boots. The cache snapshot is
  // gated so nothing can create a cache before it settles.
  await page.addInitScript(() => {
    window.__controllerAtBoot = navigator.serviceWorker.controller === null;
    window.__storageAtBoot = localStorage.length;
    const snapshot = caches.keys();
    window.__cachesAtBoot = snapshot;
    const gate = snapshot.catch(() => {});
    // Nothing may create a cache before the boot snapshot settles: the app's
    // playback restore opens audio-v1, and the SW install precaches localtune-*.
    const open = CacheStorage.prototype.open;
    CacheStorage.prototype.open = function patchedOpen(...args) {
      return gate.then(() => open.apply(this, args));
    };
    const sw = navigator.serviceWorker;
    const register = sw.register.bind(sw);
    sw.register = (...args) => gate.then(() => register(...args));
  });

  await Promise.all([
    page.waitForNavigation(),
    page.locator('[data-testid="settings-clear-data"]').click(),
  ]);

  // The reset marker is consumed at boot: the address bar is clean again.
  const bootUrl = new URL(page.url());
  expect(bootUrl.pathname).toBe('/');
  expect(bootUrl.search).toBe('');
  expect(bootUrl.hash).toBe('');

  await expect(page.locator('.wordmark')).toHaveText('localtune.');
  await expect(page.locator('#tab-queue')).toHaveAttribute('aria-selected', 'true');
  // Demo tracks live only in the queue (they are never indexed), and queue rows
  // carry no `track-row` test id, so the four demo titles are the identity.
  const queueRows = page.locator('.track-item.queue');
  await expect(queueRows).toHaveCount(4);
  expect(await queueRows.locator('.track strong').allTextContents()).toEqual([
    'Baby Girl',
    'JUST COMMUNICATION',
    'ハチミツ',
    '自由的你',
  ]);
  await expect(page.locator('.track-item.queue.now .track strong')).toHaveText('Baby Girl');

  // Landing state, sampled before any app code ran: storage really was empty.
  await expect.poll(() => page.evaluate(() => window.__storageAtBoot)).toBe(0);
  // The app's own keys are gone at assert time too; only the version sentinel
  // prepareNavigation writes at boot remains, and that is not user data.
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual(['localtune:version']);
  expect(await page.evaluate(() => window.__controllerAtBoot)).toBe(true);
  // Sampled at document-start, before the fresh boot re-registers the SW.
  await expect.poll(() => page.evaluate(() => window.__cachesAtBoot)).toEqual([]);

  const after = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('localtune');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const meta = db.transaction('meta', 'readonly').objectStore('meta').get('e2eResetSentinel');
          meta.onerror = () => reject(meta.error);
          meta.onsuccess = () => {
            const tracks = db.transaction('tracks', 'readonly').objectStore('tracks').getAll();
            tracks.onerror = () => reject(tracks.error);
            tracks.onsuccess = () => {
              db.close();
              resolve({ sentinel: meta.result, tracks: tracks.result.length });
            };
          };
        };
      }),
  );
  expect(after.sentinel).toBeUndefined();
  expect(after.tracks).toBe(0);
});
