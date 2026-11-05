import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import zhCN from '../src/i18n/zh-CN.js';

// The queue starts from a click, but the player must keep going without a new
// gesture; clipboard assertions need an explicit grant.
test.use({
  permissions: ['clipboard-read', 'clipboard-write'],
  launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] },
});

const TRACKS = [
  { path: 'Music/1.wav', title: '夜に駆ける', artist: 'YOASOBI' },
  { path: 'Music/2.wav', title: '十年', artist: '陈奕迅' },
  { path: 'Music/3.wav', title: 'Hello', artist: 'Adele' },
  { path: 'Music/4.wav', title: '晴天', artist: '周杰伦' },
  { path: 'Music/5.wav', title: 'Lemon', artist: '米津玄師' },
  { path: 'Music/6.wav', title: 'Shape of You', artist: 'Ed Sheeran' },
  { path: 'Music/7.wav', title: 'Bohemian Rhapsody', artist: 'Queen' },
];

const TEXT = [
  'YOASOBI - 夜に駆ける',
  '陈奕迅 - 十年 (Live)',
  'Adele - Hello',
  '周杰伦 - 晴天',
  '米津玄師 - Lemon (Remastered 2019)',
  'Ed Sheeran - Shape of You',
  'Some Other Band - Bohemian Rhapsody',
  'Unknown - 不存在的歌A',
  'Unknown - 不存在的歌B',
  'Unknown - 不存在的歌C',
].join('\n');

const MISSING_LINES = [
  'Unknown - 不存在的歌A',
  'Unknown - 不存在的歌B',
  'Unknown - 不存在的歌C',
];

/** Seven 2-second silent 8 kHz/16-bit PCM WAVs in OPFS plus their IDB rows. */
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

async function readOpfsFile(page, name) {
  return page.evaluate(async (fileName) => {
    const base = await navigator.storage.getDirectory();
    const music = await base.getDirectoryHandle('music');
    const handle = await music.getFileHandle(fileName);
    return (await handle.getFile()).text();
  }, name);
}

test('imports a text playlist, persists it and writes a m3u8', async ({ page }) => {
  test.setTimeout(60_000);

  // Force the OPFS import source: the directory picker would need a real grant.
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
  await expect(page.locator('[data-testid="track-row"]')).toHaveCount(7);

  await page.locator('[data-testid="vip-open"]').click();
  await page.locator('[data-testid="import-open"]').click();
  await expect(page.locator('[data-testid="import-dialog"]')).toBeVisible();
  await page.locator('[data-testid="import-name"]').fill('E2E 歌单');
  await page.locator('[data-testid="import-text"]').fill(TEXT);
  await page.locator('[data-testid="import-submit"]').click();

  await expect(
    page.locator('[data-testid="result-matched"] [data-testid="result-row"]'),
  ).toHaveCount(6);
  await expect(
    page.locator('[data-testid="result-suspect"] [data-testid="result-row"]'),
  ).toHaveCount(1);
  await expect(
    page.locator('[data-testid="result-missing"] [data-testid="result-row"]'),
  ).toHaveCount(3);
  await expect(page.locator('[data-testid="result-suspect"]')).toContainText(
    zhCN['import.reasonArtist'],
  );

  await page.locator('[data-testid="playlist-create"]').click();
  await expect(page.locator('[data-testid="playlist-row"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="vip-view"]')).toBeVisible();

  await page.locator('[data-testid="playlist-play"]').click();
  await expect
    .poll(() => page.evaluate(() => document.querySelector('audio')?.paused))
    .toBe(false);

  await page.locator('[data-testid="playlist-open"]').click();
  await expect(page.locator('[data-testid="playlist-detail"]')).toBeVisible();

  await page.locator('[data-testid="missing-copy"]').click();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toBe(MISSING_LINES.join('\n'));

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-testid="missing-download"]').click(),
  ]);
  expect(download.suggestedFilename()).toBe('E2E 歌单-missing.txt');
  const downloadPath = await download.path();
  expect(await readFile(downloadPath, 'utf8')).toBe(`${MISSING_LINES.join('\n')}\n`);

  await page.locator('[data-testid="m3u8-write"]').click();
  await expect
    .poll(async () => readOpfsFile(page, 'E2E 歌单.m3u8').catch(() => ''))
    .not.toBe('');
  const m3u8 = await readOpfsFile(page, 'E2E 歌单.m3u8');
  expect(m3u8.split('\n')[0]).toBe('#EXTM3U');
  expect(m3u8).toContain('./Music/1.wav');
  expect(m3u8).toContain('#EXTINF:2,');

  await page.reload();
  await expect(page.locator('#app h1')).toBeVisible();
  await page.locator('[data-testid="vip-open"]').click();
  await expect(page.locator('[data-testid="playlist-row"]')).toHaveCount(1);
});

// The service worker is cache-first and its fetches bypass page.route, so the
// resolver request must reach Playwright's router directly.
test.describe('same-origin proxy', () => {
  test.use({ serviceWorkers: 'block' });

  test('imports a playlist through the same-origin /api/resolve proxy', async ({ page }) => {
    test.setTimeout(60_000);

    // Force the OPFS import source: the directory picker would need a real grant.
    await page.addInitScript(() => {
      Object.defineProperty(window, 'showDirectoryPicker', {
        configurable: true,
        value: undefined,
      });
    });

    const playlistUrl = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M';
    const requested = [];
    let served = false;
    await page.route('**/api/resolve**', async (route) => {
      requested.push(route.request().url());
      if (served) {
        await route.abort();
        return;
      }
      served = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          source: 'spotify',
          name: 'E2E 代理歌单',
          items: [
            { title: '夜に駆ける', artist: 'YOASOBI', durationMs: 2000, coverUrl: null },
            { title: '不存在的代理歌', artist: 'Nobody', durationMs: 2000, coverUrl: null },
          ],
          truncated: false,
        }),
      });
    });

    await page.goto('/');
    await expect(page.locator('#app h1')).toBeVisible();

    await seedLibrary(page);
    await page.reload();
    await page.locator('[data-testid="folder-source-local"]').click();
    await page.locator('[data-testid="folder-dir-Music"]').click();
    await expect(page.locator('[data-testid="track-row"]')).toHaveCount(7);

    await page.locator('[data-testid="vip-open"]').click();
    await page.locator('[data-testid="import-open"]').click();
    await expect(page.locator('[data-testid="import-dialog"]')).toBeVisible();
    await page.locator('[data-testid="import-name"]').fill('E2E 代理歌单');
    await page.locator('[data-testid="import-url"]').fill(playlistUrl);
    await page.locator('[data-testid="import-submit"]').click();

    await expect(
      page.locator('[data-testid="result-matched"] [data-testid="result-row"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('[data-testid="result-missing"] [data-testid="result-row"]'),
    ).toHaveCount(1);

    expect(requested).toEqual([
      `http://127.0.0.1:4173/api/resolve?url=${encodeURIComponent(playlistUrl)}`,
    ]);
  });
});
