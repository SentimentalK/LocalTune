import { expect, test } from '@playwright/test';

// Auto-advance is driven by `ended`; nothing here grants a fresh user gesture
// for the next track, so the browser must allow continued playback.
test.use({
  launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] },
});

const TRACKS = [
  { path: 'Music/a.wav', title: 'a' },
  { path: 'Music/b.wav', title: 'b' },
  { path: 'Music/c.wav', title: 'c' },
];

/** Three 2-second silent 8 kHz/16-bit PCM WAVs plus their library rows. */
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

    const rows = tracks.map((track) => ({ ...track, file: wav(track.path.split('/').pop()) }));

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
  }, TRACKS);
}

async function readPlayLog(page) {
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

test('auto-advance plays three tracks gaplessly and logs the run', async ({ page }) => {
  test.setTimeout(30_000);

  // Force the FileList fallback: the picker would need a real directory grant.
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

  await expect(page.locator('#app h1')).toBeVisible();
  await page.locator('[data-testid="folder-source-local"]').click();
  await page.locator('[data-testid="folder-dir-Music"]').click();
  const rows = page.locator('[data-testid="track-row"] .row-hit');
  await expect(rows).toHaveCount(3);
  const nowTitle = page.locator('.player .meta h2');
  await expect(nowTitle).toHaveText('a');

  await rows.first().click();
  await expect(nowTitle).toHaveText('b', { timeout: 6_000 });
  await expect(nowTitle).toHaveText('c', { timeout: 6_000 });

  expect(await page.evaluate(() => document.querySelectorAll('audio').length)).toBe(1);

  await expect
    .poll(
      async () => {
        const log = await readPlayLog(page);
        return log.filter((row) => row.type === 'trackchange' && row.detail?.source === 'auto')
          .length;
      },
      { timeout: 8_000 },
    )
    .toBeGreaterThanOrEqual(2);

  const log = await readPlayLog(page);
  const endedAt = log.findIndex((row) => row.type === 'audio:ended');
  expect(endedAt).toBeGreaterThanOrEqual(0);

  const after = log.slice(endedAt + 1);
  const changeAt = after.findIndex(
    (row) => row.type === 'trackchange' && row.detail?.source === 'auto',
  );
  const playAt = after.findIndex((row) => row.type === 'audio:play');
  expect(changeAt).toBeGreaterThanOrEqual(0);
  expect(playAt).toBeGreaterThan(changeAt);
  expect(
    after.filter((row) => row.type === 'trackchange' && row.detail?.source === 'auto').length,
  ).toBeGreaterThanOrEqual(2);
});

test('shuffle and repeat survive an immediate reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#app h1')).toBeVisible();

  const shuffle = page.locator('[data-testid="control-shuffle"]');
  const repeat = page.locator('[data-testid="control-repeat"]');

  await shuffle.click();
  await repeat.click();

  const selected = async () => {
    await expect(shuffle).toHaveClass(/is-on/);
    await expect(shuffle).toHaveAttribute('aria-pressed', 'true');
    await expect(repeat).toHaveClass(/is-on/);
    await expect(repeat).toHaveAttribute('aria-pressed', 'true');
    await expect(repeat).toContainText('∞');
  };

  // Reload before the 1s IndexedDB debounce can flush: prefs must be enough.
  await page.reload();
  await expect(page.locator('#app h1')).toBeVisible();
  await selected();

  await page.reload();
  await expect(page.locator('#app h1')).toBeVisible();
  await selected();

  // Read the theme from the CSS variables instead of pinning a colour: a
  // theme change must not turn this into a false failure.
  const style = await page.evaluate(() => {
    const button = document.querySelector('[data-testid="control-shuffle"]');
    const computed = getComputedStyle(button);
    const root = getComputedStyle(document.documentElement);
    const rgb = (value) => {
      const probe = document.createElement('span');
      probe.style.color = value.trim();
      document.body.append(probe);
      const out = getComputedStyle(probe).color;
      probe.remove();
      return out;
    };
    return {
      background: computed.backgroundColor,
      color: computed.color,
      accent: rgb(root.getPropertyValue('--accent')),
      accentFg: rgb(root.getPropertyValue('--accent-fg')),
      surface: rgb(root.getPropertyValue('--surface')),
      badge: (() => {
        const badge = document.querySelector('[data-testid="control-repeat"] .badge');
        const badgeStyle = getComputedStyle(badge);
        return { background: badgeStyle.backgroundColor, color: badgeStyle.color };
      })(),
    };
  });
  expect(style.background).toBe(style.accent);
  expect(style.background).not.toBe(style.surface);
  expect(style.color).toBe(style.accentFg);
  expect(style.badge.background).toBe(style.accentFg);
  expect(style.badge.color).toBe(style.accent);

  const luminance = (rgbText) => {
    const [r, g, b] = rgbText.match(/\d+/g).slice(0, 3).map((value) => {
      const channel = Number(value) / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (first, second) => {
    const a = luminance(first);
    const b = luminance(second);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  expect(ratio(style.background, style.color)).toBeGreaterThanOrEqual(4.5);
});
