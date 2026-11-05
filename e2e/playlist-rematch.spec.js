import { expect, test } from '@playwright/test';
import zhCN from '../src/i18n/zh-CN.js';

// Rescanning from Settings is the trigger; the playlist rows come from a text
// import, exactly like e2e/playlist.spec.js.
test.use({
  launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] },
});

const TRACKS = [
  { path: 'Music/1.wav', title: '夜に駆ける', artist: 'YOASOBI' },
  { path: 'Music/2.wav', title: '十年', artist: '陈奕迅' },
];

const TEXT = ['YOASOBI - 夜に駆ける', '陈奕迅 - 十年', 'Unknown Artist - Late Arrival'].join('\n');

/** Two 2-second silent 8 kHz/16-bit PCM WAVs in OPFS plus their IDB rows. */
async function seedLibrary(page) {
  await page.evaluate(async (tracks) => {
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

    const base = await navigator.storage.getDirectory();
    const music = await base.getDirectoryHandle('music', { create: true });
    const folder = await music.getDirectoryHandle('Music', { create: true });

    const rows = [];
    for (const track of tracks) {
      const name = track.path.split('/').pop();
      const handle = await folder.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(wav(name));
      await writable.close();
      const stored = await handle.getFile();
      rows.push({ ...track, size: stored.size, mtime: stored.lastModified });
    }

    await new Promise((resolve, reject) => {
      const open = indexedDB.open('localtune');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(['meta', 'tracks', 'opfsIndex'], 'readwrite');
        tx.objectStore('meta').put({ key: 'opfsRootName', value: 'Music' });
        tx.objectStore('meta').put({ key: 'localMode', value: 'import' });
        const trackStore = tx.objectStore('tracks');
        const indexStore = tx.objectStore('opfsIndex');
        for (const row of rows) {
          trackStore.put({
            id: `opfs:${row.path}`,
            path: row.path,
            title: row.title,
            artist: row.artist,
            album: '',
            year: null,
            trackNo: null,
            duration: 2,
            mtime: row.mtime,
            size: row.size,
            cover: null,
            source: 'opfs',
            externalIds: {},
          });
          indexStore.put({ path: row.path, size: row.size, mtime: row.mtime });
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

/**
 * Drop `Music/3.wav` into OPFS and mirror it in IDB with the tags matching the
 * still-missing playlist row. The row's `size`/`mtime` come from the stored
 * file, so the rescan sees it as unchanged and keeps the title (WAV has no
 * tags, so a rebuilt row would fall back to the file name).
 */
async function addLateArrival(page) {
  await page.evaluate(async () => {
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

    const base = await navigator.storage.getDirectory();
    const music = await base.getDirectoryHandle('music');
    const folder = await music.getDirectoryHandle('Music');
    const handle = await folder.getFileHandle('3.wav', { create: true });
    const writable = await handle.createWritable();
    await writable.write(new File([buffer], '3.wav', { type: 'audio/wav', lastModified: Date.now() }));
    await writable.close();
    const stored = await handle.getFile();

    await new Promise((resolve, reject) => {
      const open = indexedDB.open('localtune');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(['tracks', 'opfsIndex'], 'readwrite');
        tx.objectStore('tracks').put({
          id: 'opfs:Music/3.wav',
          path: 'Music/3.wav',
          title: 'Late Arrival',
          artist: 'Unknown Artist',
          album: '',
          year: null,
          trackNo: null,
          duration: 2,
          mtime: stored.lastModified,
          size: stored.size,
          cover: null,
          source: 'opfs',
          externalIds: {},
        });
        tx.objectStore('opfsIndex').put({
          path: 'Music/3.wav',
          size: stored.size,
          mtime: stored.lastModified,
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

const columnCount = (page, testId) =>
  page
    .locator(`[data-testid="playlist-detail"] [data-testid="${testId}"] header span`)
    .last();

test('rescan re-matches missing playlist rows and toasts the count', async ({ page }) => {
  test.setTimeout(60_000);

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

  await page.locator('[data-testid="folder-source-local"]').click();
  await page.locator('[data-testid="folder-dir-Music"]').click();
  await expect(page.locator('[data-testid="track-row"]')).toHaveCount(2);

  await page.locator('[data-testid="vip-open"]').click();
  await page.locator('[data-testid="import-open"]').click();
  await expect(page.locator('[data-testid="import-dialog"]')).toBeVisible();
  await page.locator('[data-testid="import-name"]').fill('补齐测试');
  await page.locator('[data-testid="import-text"]').fill(TEXT);
  await page.locator('[data-testid="import-submit"]').click();

  await expect(
    page.locator('[data-testid="result-matched"] [data-testid="result-row"]'),
  ).toHaveCount(2);
  await expect(
    page.locator('[data-testid="result-missing"] [data-testid="result-row"]'),
  ).toHaveCount(1);

  await page.locator('[data-testid="playlist-create"]').click();
  await expect(page.locator('[data-testid="playlist-row"]')).toHaveCount(1);

  await page.locator('[data-testid="playlist-open"]').click();
  await expect(page.locator('[data-testid="playlist-detail"]')).toBeVisible();
  await expect(columnCount(page, 'result-matched')).toHaveText('2');
  await expect(
    page.locator('[data-testid="playlist-detail"] [data-testid="result-missing"] [data-testid="result-row"]'),
  ).toHaveCount(1);

  // The file and its row appear while the app is already running.
  await addLateArrival(page);

  // VIP hides the other header actions, so leave it before opening settings.
  await page.locator('[data-testid="settings-close"]').click();
  await expect(page.locator('#tab-folders')).toBeVisible();
  await page.locator('[data-testid="settings-open"]').click();
  await page.locator('[data-testid="settings-sync-local"]').click();

  const expectedToast = zhCN['playlists.rematchAdded'].replace('{count}', '1');
  expect(expectedToast).toBe('补齐 1 首');
  await expect(page.locator('.toast')).toContainText(expectedToast);

  await page.locator('[data-testid="settings-close"]').click();
  await page.locator('[data-testid="vip-open"]').click();
  await expect(page.locator('[data-testid="playlist-detail"]')).toBeVisible();
  await expect(columnCount(page, 'result-matched')).toHaveText('3');
  await expect(columnCount(page, 'result-missing')).toHaveText('0');
  await expect(
    page.locator('[data-testid="playlist-detail"] [data-testid="result-missing"] [data-testid="result-row"]'),
  ).toHaveCount(0);
});
