import { expect, test } from '@playwright/test';

const TRACKS = [
  { path: 'Music/qingtian.wav', title: '晴天', artist: '周杰伦', plays: 5, addedAt: 1 },
  { path: 'Music/jiangnan.wav', title: '江南', artist: '林俊杰', plays: 0, addedAt: 2 },
  { path: 'Music/yoru.wav', title: '夜に駆ける', artist: 'YOASOBI', plays: 2, addedAt: 3 },
];

/** Three 2-second WAVs, library rows and their stats rows. */
async function seedLibrary(page) {
  return page.evaluate(async (tracks) => {
    const wav = (name) => {
      const sampleRate = 8000;
      const samples = sampleRate * 2;
      const bytes = 44 + samples * 2;
      const buffer = new ArrayBuffer(bytes);
      const view = new DataView(buffer);
      const ascii = (offset, text) => {
        for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
      };
      ascii(0, 'RIFF');
      view.setUint32(4, bytes - 8, true);
      ascii(8, 'WAVE');
      ascii(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      ascii(36, 'data');
      view.setUint32(40, samples * 2, true);
      return new File([buffer], name, { type: 'audio/wav', lastModified: Date.now() });
    };

    const rows = tracks.map((track) => ({
      ...track,
      file: wav(track.path.split('/').pop()),
    }));

    await new Promise((resolve, reject) => {
      const open = indexedDB.open('localtune');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(['meta', 'tracks', 'stats'], 'readwrite');
        tx.objectStore('meta').put({
          key: 'fileList',
          value: rows.map(({ path, file }) => ({ path, file })),
        });
        tx.objectStore('meta').put({ key: 'localMode', value: 'reference' });
        const store = tx.objectStore('tracks');
        const statsStore = tx.objectStore('stats');
        for (const { path, title, artist, plays, addedAt, file } of rows) {
          const id = `fsa:${path}`;
          store.put({
            id,
            path,
            title,
            artist,
            album: '',
            year: null,
            trackNo: null,
            duration: 2,
            mtime: file.lastModified,
            size: file.size,
            cover: null,
            source: 'fsa',
            externalIds: {},
          });
          statsStore.put({ id, plays, lastPlayedAt: null, addedAt });
        }
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, TRACKS);
}

const searchRows = (page) => page.locator('[data-testid="track-row"]');

test('search filters the library and auto lists sort by stats', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: undefined,
    });
  });

  await page.goto('/');
  await expect(page.locator('#app h1')).toBeVisible();

  await seedLibrary(page);
  await page.reload();

  // The folders view opens on the source list; the seeds live in Music/.
  await page.locator('[data-testid="folder-source-local"]').click();
  await page.locator('[data-testid="folder-dir-Music"]').click();
  await expect(searchRows(page)).toHaveCount(3);

  // Search covers the whole library, whatever the folder position.
  await page.locator('[data-testid="search-open"]').click();
  const input = page.locator('[data-testid="search-input"]');
  await input.fill('周');
  await expect(searchRows(page)).toHaveCount(1);
  await expect(page.locator('[data-testid="track-row"] b')).toHaveText('晴天');
  await expect(page.locator('[data-testid="search-count"]')).toContainText('1');
  await expect(page.locator('[data-testid="search-group-artist"]')).toBeVisible();

  await page.locator('[data-testid="search-clear"]').click();
  await expect(searchRows(page)).toHaveCount(0);
  await expect(input).toHaveValue('');

  // Auto lists live under Playlists and open as a detail panel.
  await page.locator('#tab-playlists').click();
  await page.locator('[data-testid="auto-list-open-most"]').click();
  const detailRows = page.locator('[data-testid="auto-list-detail"] [data-testid="track-row"]');
  await expect(detailRows.first().locator('b')).toHaveText('晴天');

  await page.locator('[data-testid="auto-list-open-never"]').click();
  await expect(detailRows).toHaveCount(1);
  await expect(detailRows.first().locator('b')).toHaveText('江南');

  await page.locator('[data-testid="auto-list-open-recent"]').click();
  await expect(detailRows.first().locator('b')).toHaveText('夜に駆ける');
});

test('search shows an empty state and Escape clears the query', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: undefined,
    });
  });

  await page.goto('/');
  await expect(page.locator('#app h1')).toBeVisible();

  await seedLibrary(page);
  await page.reload();

  await page.locator('[data-testid="search-open"]').click();
  const input = page.locator('[data-testid="search-input"]');
  await input.fill('不存在');
  await expect(page.locator('[data-testid="search-empty"]')).toBeVisible();
  await expect(searchRows(page)).toHaveCount(0);

  await input.press('Escape');
  await expect(input).toHaveValue('');
  await expect(page.locator('[data-testid="search-empty"]')).toBeHidden();
  await expect(page.locator('[data-testid="search-count"]')).toBeHidden();
});
