import { expect, test } from '@playwright/test';
import { installGraphMock } from './support/graph-mock.js';

const FILES = [
  { id: 'track-1', name: 'one.mp3' },
  { id: 'track-2', name: 'two.mp3' },
];

async function signInAndPickMusic(page, { count = '2' } = {}) {
  await page.goto('/');
  await expect(page.locator('#app h1')).toHaveText('LocalTune');

  await page.locator('[data-testid="settings-open"]').click();
  await page.locator('[data-testid="settings-source-onedrive"]').click();

  await expect(page.locator('[data-testid="onedrive-picker"]')).toBeVisible();
  await expect(page.locator('[data-testid="onedrive-folder"]').first()).toHaveText('Music');
  await page.locator('[data-testid="onedrive-folder"]').first().click();
  await page.locator('[data-testid="onedrive-picker-choose"]').click();

  await expect(page.locator('[data-testid="onedrive-picker"]')).toBeHidden();
  await expect(page.locator('[data-testid="source-row-onedrive"]')).toContainText(count);
}

async function backToFolders(page) {
  await page.locator('[data-testid="settings-back"]').click();
  await expect(page.locator('#tab-folders')).toBeVisible();
}

async function openSource(page, kind) {
  await page.locator(`[data-testid="folder-source-${kind}"]`).click();
  await expect(page.locator('[data-testid="track-row"]').first()).toBeVisible();
}

async function expectPlaying(page) {
  await expect(page.locator('.controls .btn.main')).toHaveAttribute('aria-label', '暂停');
  await expect
    .poll(async () => page.locator('.progress time').first().textContent(), { timeout: 10_000 })
    .not.toBe('0:00');
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

/** Two 2-second silent WAVs plus their local library rows. */
async function seedLocalLibrary(page) {
  await page.evaluate(async () => {
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

    const rows = ['Music/a.wav', 'Music/b.wav'].map((path) => ({
      path,
      file: wav(path.split('/').pop()),
    }));

    await new Promise((resolve, reject) => {
      const open = indexedDB.open('localtune');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(['meta', 'tracks'], 'readwrite');
        tx.objectStore('meta').put({
          key: 'fileList',
          value: rows.map(({ path, file }) => ({ path, file })),
        });
        tx.objectStore('meta').put({ key: 'localMode', value: 'reference' });
        const store = tx.objectStore('tracks');
        for (const { path, file } of rows) {
          store.put({
            id: `fsa:${path}`,
            path,
            title: path.split('/').pop().replace('.wav', ''),
            artist: '',
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
        }
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  });
}

test('lists OneDrive tracks while tags are pending and plays from the cache', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const mock = await installGraphMock(page, { files: FILES, holdRanges: true });

  await signInAndPickMusic(page);
  await backToFolders(page);

  // Sync cached both whole files; tag reads are still parked at the gate.
  expect(mock.wholeRequests).toHaveLength(2);
  expect(mock.rangeDone).toBe(0);

  await openSource(page, 'onedrive');
  await expect(page.locator('[data-testid="track-row"]')).toHaveCount(2);
  await page.locator('[data-testid="track-row"] .row-hit').first().click();
  await expectPlaying(page);

  // Playback read Cache Storage, and tag reads are still parked.
  expect(mock.wholeRequests).toHaveLength(2);
  expect(mock.rangeDone).toBe(0);
  mock.releaseRanges();
});

test('a single failed tag read keeps the source and both tracks', async ({ page }) => {
  test.setTimeout(90_000);
  await installGraphMock(page, { files: FILES, failRangeIds: ['track-2'] });

  await signInAndPickMusic(page);
  await expect(page.locator('[data-testid="source-row-onedrive"] .settings-error')).toBeHidden();

  await backToFolders(page);
  await openSource(page, 'onedrive');
  await expect(page.locator('[data-testid="track-row"]')).toHaveCount(2);
  // track-2 kept its placeholder row with the file-name title.
  await expect(page.locator('[data-testid="track-row"]').nth(1)).toContainText('two');

  await page.locator('[data-testid="track-row"] .row-hit').first().click();
  await expectPlaying(page);

  await page.locator('[data-testid="settings-open"]').click();
  await expect(page.locator('[data-testid="source-row-onedrive"] .settings-error')).toBeHidden();
});

test('a single failed playback never marks the source or blocks the next track', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const mock = await installGraphMock(page, { files: FILES, failWholeIds: ['track-2'] });
  const countFor = (id) => mock.wholeRequests.filter((url) => url.endsWith(`/${id}`)).length;

  await signInAndPickMusic(page);
  // The cache pass retried the broken file once; track-1 is cached.
  await expect.poll(() => countFor('track-1'), { timeout: 10_000 }).toBe(1);
  await expect
    .poll(() => countFor('track-2'), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(2);

  // The uncached path is reported on the source row without an error state.
  await expect(page.locator('[data-testid="source-row-onedrive"] .settings-error')).toBeVisible();
  await expect(page.locator('[data-testid="source-row-onedrive"] .settings-error')).toContainText(
    'two.mp3',
  );

  await backToFolders(page);
  await openSource(page, 'onedrive');
  await expect(page.locator('[data-testid="track-row"]')).toHaveCount(2);

  // Rows sort by tag track number, so address them by source track id.
  const cachedRow = page.locator('[data-testid="track-row"][data-track-id$="one.mp3"]');
  const failedRow = page.locator('[data-testid="track-row"][data-track-id$="two.mp3"]');
  await expect(cachedRow).toHaveCount(1);
  await expect(failedRow).toHaveCount(1);

  const cachedBefore = countFor('track-1');
  await cachedRow.locator('.row-hit').click();
  await expectPlaying(page);
  // track-1 came from the cache: no extra whole request.
  await page.waitForTimeout(300);
  expect(countFor('track-1')).toBe(cachedBefore);

  const failedBefore = countFor('track-2');
  await failedRow.locator('.row-hit').click();
  // The download is retried once, then playback gives up on this track only.
  await expect
    .poll(() => countFor('track-2'), { timeout: 10_000 })
    .toBeGreaterThan(failedBefore);
  // The failed load hands over to the cached neighbour; the button returns to
  // "play" once that finishes, i.e. the failure never stuck the player.
  await expect(page.locator('.controls .btn.main')).toHaveAttribute('aria-label', '播放', {
    timeout: 15_000,
  });
  await expect(page.locator('[data-testid="track-row"]')).toHaveCount(2);

  await page.locator('[data-testid="settings-open"]').click();
  await expect(page.locator('[data-testid="source-row-onedrive"] .settings-error')).toBeVisible();
  await backToFolders(page);

  await cachedRow.locator('.row-hit').click();
  await expectPlaying(page);
});

test('local and OneDrive rows show source names together', async ({ page }) => {
  test.setTimeout(90_000);
  await installGraphMock(page, { files: FILES });

  // Force the FileList fallback so the local library can be seeded.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: undefined,
    });
  });

  await page.goto('/');
  await expect(page.locator('#app h1')).toHaveText('LocalTune');
  await seedLocalLibrary(page);
  await page.reload();

  await expect(page.locator('[data-testid="folder-source-local"]')).toBeVisible();
  await expect(page.locator('[data-testid="folder-source-local"] b')).toHaveText('本地');

  await page.locator('[data-testid="settings-open"]').click();
  await page.locator('[data-testid="settings-source-onedrive"]').click();
  await expect(page.locator('[data-testid="onedrive-picker"]')).toBeVisible();
  await page.locator('[data-testid="onedrive-folder"]').first().click();
  await page.locator('[data-testid="onedrive-picker-choose"]').click();
  await expect(page.locator('[data-testid="onedrive-picker"]')).toBeHidden();
  await backToFolders(page);

  const localRow = page.locator('[data-testid="folder-source-local"]');
  const cloudRow = page.locator('[data-testid="folder-source-onedrive"]');
  await expect(localRow).toBeVisible();
  await expect(cloudRow).toBeVisible();
  await expect(localRow.locator('b')).toHaveText('本地');
  await expect(cloudRow.locator('b')).toHaveText('OneDrive');
  await expect(cloudRow).not.toContainText('Music');

  // The sync cached the cloud files only; local files stay where they are.
  const keys = await page.evaluate(async () => {
    const cache = await caches.open('audio-v1');
    return (await cache.keys()).map((request) =>
      decodeURIComponent(new URL(request.url).pathname.replace('/__audio/', '')),
    );
  });
  expect(keys.filter((key) => key.startsWith('fsa:'))).toHaveLength(0);
  expect(keys.filter((key) => key.startsWith('onedrive:'))).toHaveLength(2);
});

test('a granted source with zero tracks still gets a row', async ({ page }) => {
  test.setTimeout(90_000);
  await installGraphMock(page, { files: [] });

  await signInAndPickMusic(page, { count: '0' });
  await expect(page.locator('[data-testid="source-row-onedrive"]')).toBeVisible();

  await backToFolders(page);
  const row = page.locator('[data-testid="folder-source-onedrive"]');
  await expect(row).toBeVisible();
  await expect(row.locator('b')).toHaveText('OneDrive');
});

test('removing a source drops its tracks and cached audio', async ({ page }) => {
  test.setTimeout(120_000);
  await installGraphMock(page, { files: FILES });

  await signInAndPickMusic(page);
  await backToFolders(page);
  await openSource(page, 'onedrive');
  const rows = page.locator('[data-testid="track-row"] .row-hit');
  await rows.first().click();
  await expectPlaying(page);
  await rows.nth(1).click();
  await expectPlaying(page);

  await page.locator('[data-testid="settings-open"]').click();
  const cachedAudio = page.locator('[data-testid="storage-audio"] b');
  await expect(cachedAudio).not.toHaveText('0 B', { timeout: 15_000 });

  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('[data-testid="settings-onedrive-remove"]').click();

  await expect(cachedAudio).toHaveText('0 B', { timeout: 15_000 });
  await backToFolders(page);
  await expect(page.locator('[data-testid="folder-source-onedrive"]')).toHaveCount(0);

  const tracks = await readStore(page, 'tracks');
  expect(tracks.filter((track) => track.source === 'onedrive')).toHaveLength(0);
  const cacheIndex = await readStore(page, 'cacheIndex');
  expect(cacheIndex).toHaveLength(0);
});

test('clearing the audio cache also clears the play log', async ({ page }) => {
  test.setTimeout(120_000);
  await installGraphMock(page, { files: FILES });

  await signInAndPickMusic(page);
  await backToFolders(page);
  await openSource(page, 'onedrive');
  await page.locator('[data-testid="track-row"] .row-hit').first().click();
  await expectPlaying(page);

  await expect
    .poll(async () => (await readStore(page, 'playlog')).length, { timeout: 10_000 })
    .toBeGreaterThan(0);

  // Pause first so no audio event lands after the clear.
  await page.locator('.controls .btn.main').click();
  await page.waitForTimeout(300);

  await page.locator('[data-testid="settings-open"]').click();
  await expect(page.locator('[data-testid="clear-cache"]')).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('[data-testid="clear-cache"]').click();

  await expect.poll(async () => (await readStore(page, 'playlog')).length).toBe(0);
});
