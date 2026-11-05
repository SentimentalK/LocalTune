import { expect, test } from '@playwright/test';
import { installGraphMock } from './support/graph-mock.js';

const FILES = [
  { id: 'track-1', name: 'one.mp3' },
  { id: 'track-2', name: 'Jazz/two.mp3' },
];

async function waitForServiceWorker(page) {
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.active?.state === 'activated';
  });
}

async function signInAndPickMusic(page) {
  await page.goto('/');
  await expect(page.locator('#app h1')).toHaveText('LocalTune');

  await page.locator('[data-testid="settings-open"]').click();
  await page.locator('[data-testid="source-connect-onedrive"]').click();

  await expect(page.locator('[data-testid="onedrive-picker"]')).toBeVisible();
  await expect(page.locator('[data-testid="onedrive-folder"]').first()).toHaveText('Music');
  await page.locator('[data-testid="onedrive-folder"]').first().click();
  await page.locator('[data-testid="onedrive-picker-choose"]').click();

  await expect(page.locator('[data-testid="onedrive-picker"]')).toBeHidden();
  await expect(page.locator('[data-testid="source-row-onedrive"]')).toContainText('2');
}

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

/** Seed a playlist and a 1 GB cache limit, then reload so the store loads both. */
async function seedPlaylistAndSettings(page) {
  await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const open = indexedDB.open('localtune');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(['playlists', 'meta'], 'readwrite');
        tx.objectStore('playlists').put({
          id: 'pl-seed',
          name: 'Seed',
          source: 'text',
          sourceUrl: null,
          items: [],
          createdAt: 1,
        });
        tx.objectStore('meta').put({
          key: 'settings',
          value: {
            language: 'auto',
            cacheLimitBytes: 1024 ** 3,
            youtubeApiKey: '',
            playlistProxyUrl: '',
            leveling: false,
            gapless: true,
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
  await page.reload();
  await expect(page.locator('#app h1')).toHaveText('LocalTune');
}

test('the cache limit chooser stays on one row at 360px in every locale', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/');
  await page.locator('[data-testid="settings-open"]').click();
  await expect(page.locator('[data-testid="settings-section-storage"]')).toBeVisible();

  const limits = page.locator('[data-testid^="cache-limit-"]');
  await expect(limits).toHaveCount(5);

  // Every language shortest label must fit: no clipped cell, no ellipsis.
  for (const locale of ['zh-CN', 'en', 'zh-TW', 'ja']) {
    if (locale !== 'zh-CN') {
      await page.locator(`[data-testid="language-${locale}"]`).click();
      await expect(page.locator('[data-testid="settings-section-storage"]')).toBeVisible();
    }

    const segments = await limits.evaluateAll((nodes) =>
      nodes.map((node) => {
        const style = getComputedStyle(node);
        return {
          id: node.dataset.testid,
          top: node.offsetTop,
          scrollWidth: node.scrollWidth,
          clientWidth: node.clientWidth,
          textOverflow: style.textOverflow,
          text: node.textContent ?? '',
        };
      }),
    );

    expect(segments.length, `${locale} limit segments`).toBe(5);
    expect(new Set(segments.map((segment) => segment.top)).size, `${locale} one row`).toBe(1);
    for (const segment of segments) {
      expect(
        segment.scrollWidth,
        `${locale} ${segment.id} text clipped`,
      ).toBeLessThanOrEqual(segment.clientWidth);
      expect(segment.textOverflow, `${locale} ${segment.id} ellipsis`).not.toBe('ellipsis');
      expect(segment.text, `${locale} ${segment.id} placeholder ellipsis`).not.toContain('…');
    }

    const overflow = await page.locator('.storage-limit').evaluate((node) => ({
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
    }));
    expect(overflow.scrollWidth, `${locale} limit row overflow`).toBeLessThanOrEqual(
      overflow.clientWidth,
    );
  }

  await expect(page.locator('[data-testid="clear-all"]')).toHaveCount(1);
  for (const id of ['clear-cache', 'clear-library', 'storage-import', 'storage-pins']) {
    await expect(page.locator(`[data-testid="${id}"]`)).toHaveCount(0);
  }
});

test('Clear all drops derived data but keeps sources, playlists and settings', async ({
  page,
}) => {
  test.setTimeout(180_000);

  const mock = await installGraphMock(page, { files: FILES });
  await signInAndPickMusic(page);
  await waitForServiceWorker(page);
  await seedPlaylistAndSettings(page);

  const seededTracks = await readStore(page, 'tracks');
  expect(seededTracks.length).toBe(2);

  await page.locator('[data-testid="settings-open"]').click();
  const clearAll = page.locator('[data-testid="clear-all"]');
  await expect(clearAll).toBeVisible();
  await expect(page.locator('[data-testid="cache-limit-1"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  const downloadsBefore = mock.wholeRequests.length;
  page.once('dialog', (dialog) => dialog.accept());
  await clearAll.click();

  await expect(
    page.locator('[data-testid="storage-audio"] b'),
  ).toHaveText('0 B', { timeout: 15_000 });

  await expect
    .poll(async () => (await readStore(page, 'tracks')).length, { timeout: 15_000 })
    .toBe(0);
  await expect
    .poll(async () => (await readStore(page, 'cacheIndex')).length, { timeout: 15_000 })
    .toBe(0);
  await expect
    .poll(async () => (await readStore(page, 'stats')).length, { timeout: 15_000 })
    .toBe(0);
  await expect
    .poll(async () => (await readStore(page, 'playlog')).length, { timeout: 15_000 })
    .toBe(0);

  const cloudRow = page.locator('[data-testid="source-row-onedrive"]');
  await expect(cloudRow.locator('button')).toHaveCount(3);
  await expect(cloudRow).toContainText('0');

  const playlists = await readStore(page, 'playlists');
  expect(playlists.filter((row) => row.id === 'pl-seed')).toHaveLength(1);

  const meta = await readStore(page, 'meta');
  const settings = meta.find((row) => row.key === 'settings');
  expect(settings?.value?.cacheLimitBytes).toBe(1024 ** 3);

  // No automatic rescan: nothing is downloaded and the index stays empty.
  await page.waitForTimeout(3000);
  expect(mock.wholeRequests.length).toBe(downloadsBefore);
  expect((await readStore(page, 'tracks')).length).toBe(0);
});
