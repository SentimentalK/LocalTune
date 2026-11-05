import { expect, test } from '@playwright/test';

test.use({
  launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] },
});

/** Two 2-second silent WAVs plus their library rows. */
async function seedLibrary(page) {
  return page.evaluate(async () => {
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

    const rows = [
      { path: 'Music/a.wav', title: 'a', file: wav('a.wav') },
      { path: 'Music/b.wav', title: 'b', file: wav('b.wav') },
    ];

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
        for (const { path, title, file } of rows) {
          store.put({
            id: `fsa:${path}`,
            path,
            title,
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

test('sleep timer set to end of track stops after one song', async ({ page }) => {
  test.setTimeout(30_000);

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
  const rows = page.locator('[data-testid="track-row"] .row-hit');
  await expect(rows).toHaveCount(2);

  await page.locator('[data-testid="settings-open"]').click();
  await page.locator('[data-testid="sleep-end"]').click();
  await expect(page.locator('[data-testid="sleep-end"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('[data-testid="settings-close"]').click();

  const nowTitle = page.locator('.player .meta h2');
  await rows.first().click();
  await expect(nowTitle).toHaveText('a');
  await expect(page.locator('.player')).toHaveClass(/playing/);

  // The 2 s track ends without advancing to "b": the sleep timer stops it.
  await page.waitForTimeout(3_000);

  await expect(nowTitle).toHaveText('a');
  await expect(page.locator('.player')).not.toHaveClass(/playing/);
  await expect(page.locator('.btn.main')).toHaveAttribute('aria-label', '播放');
});
