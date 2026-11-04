import { expect, test } from '@playwright/test';

test.use({
  launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] },
});

const TRACKS = [
  { path: 'Music/a.wav', title: 'a', duration: 4, seconds: 4 },
  { path: 'Music/b.wav', title: 'b', duration: 2, seconds: 2 },
];

const SIDECARS = [
  {
    path: 'Music/a.lrc',
    text: '[00:00.00]第一行\n[00:01.00]第二行\n[00:02.00]第三行\n',
  },
];

/** Silent PCM WAV files, the sidecar `.lrc`, plus their library rows. */
async function seedLibrary(page, { tracks, sidecars }) {
  return page.evaluate(async ({ tracks, sidecars }) => {
    const wav = (name, seconds) => {
      const sampleRate = 8000;
      const samples = sampleRate * seconds;
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
      file: wav(track.path.split('/').pop(), track.seconds),
    }));
    const lyricRows = sidecars.map((sidecar) => ({
      ...sidecar,
      file: new File([sidecar.text], sidecar.path.split('/').pop(), {
        type: 'text/plain',
        lastModified: Date.now(),
      }),
    }));

    await new Promise((resolve, reject) => {
      const open = indexedDB.open('localtune');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(['meta', 'tracks'], 'readwrite');
        tx.objectStore('meta').put({
          key: 'fileList',
          value: [...rows, ...lyricRows].map(({ path, file }) => ({ path, file })),
        });
        tx.objectStore('meta').put({ key: 'localMode', value: 'reference' });
        const store = tx.objectStore('tracks');
        for (const { path, title, duration, file } of rows) {
          store.put({
            id: `fsa:${path}`,
            path,
            title,
            artist: '',
            album: '',
            year: null,
            trackNo: null,
            duration,
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
  }, { tracks, sidecars });
}

async function openLyricsView(page) {
  await page.locator('[data-testid="lyrics-open"]').click();
  await expect(page.locator('[data-testid="lyrics-view"]')).toBeVisible();
}

test('lyrics view highlights the sidecar lines as playback advances', async ({ page }) => {
  test.setTimeout(30_000);

  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: undefined,
    });
  });

  await page.goto('/');
  await expect(page.locator('#app h1')).toBeVisible();

  await seedLibrary(page, { tracks: TRACKS, sidecars: SIDECARS });
  await page.reload();

  const rows = page.locator('li.row .row-hit');
  await expect(rows).toHaveCount(2);
  await rows.first().click();
  await expect(page.locator('.player .meta h2')).toHaveText('a');

  await openLyricsView(page);

  const lines = page.locator('[data-testid="lyric-line"]');
  await expect(lines).toHaveCount(3);
  await expect(lines.first()).toHaveClass(/is-active/);
  await expect(lines.first()).toHaveAttribute('aria-current', 'true');

  // Second line becomes active around the 1 s mark.
  await expect
    .poll(async () => lines.nth(1).getAttribute('class'), { timeout: 5_000 })
    .toContain('is-active');
  await expect(lines.nth(1)).toHaveAttribute('aria-current', 'true');
  await expect(lines.first()).not.toHaveClass(/is-active/);
});

test('lyrics view reports a track without lyrics', async ({ page }) => {
  test.setTimeout(30_000);

  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: undefined,
    });
  });

  await page.goto('/');
  await expect(page.locator('#app h1')).toBeVisible();

  await seedLibrary(page, { tracks: TRACKS, sidecars: SIDECARS });
  await page.reload();

  const rows = page.locator('li.row .row-hit');
  await expect(rows).toHaveCount(2);
  await rows.nth(1).click();
  await expect(page.locator('.player .meta h2')).toHaveText('b');

  await openLyricsView(page);

  await expect(page.locator('[data-testid="lyrics-empty"]')).toBeVisible();
  await expect(page.locator('[data-testid="lyric-line"]')).toHaveCount(0);

  await page.locator('[data-testid="lyrics-back"]').click();
  await expect(page.locator('[data-testid="lyrics-view"]')).toBeHidden();
  await expect(page.locator('#tab-tracks')).toBeVisible();
});
