import { expect, test } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test.use({
  launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] },
});

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

/** A 16-bit mono PCM WAV of silence; 44-byte RIFF header, no metadata. */
function wavBuffer({ seconds = 2, sampleRate = 8000 } = {}) {
  const samples = sampleRate * seconds;
  const bytes = 44 + samples * 2;
  const buffer = Buffer.alloc(bytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(bytes - 8, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
}

async function makeImportDir(names) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'localtune-import-'));
  for (const name of names) await writeFile(path.join(dir, name), wavBuffer());
  return dir;
}

/** Seed one playable track through the FileList fallback (no directory grant). */
async function seedSingleTrack(page) {
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

    const file = new File([buffer], 'a.wav', { type: 'audio/wav', lastModified: Date.now() });

    await new Promise((resolve, reject) => {
      const open = indexedDB.open('localtune');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(['meta', 'tracks'], 'readwrite');
        tx.objectStore('meta').put({ key: 'fileList', value: [{ path: 'Music/a.wav', file }] });
        tx.objectStore('meta').put({ key: 'localMode', value: 'reference' });
        tx.objectStore('tracks').put({
          id: 'fsa:Music/a.wav',
          path: 'Music/a.wav',
          title: 'a',
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
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  });
}

test('import mode copies files into OPFS and survives a reload', async ({ page }) => {
  test.setTimeout(60_000);
  const dir = await makeImportDir(['a.wav', 'b.wav']);
  let chooserCount = 0;
  page.on('filechooser', () => {
    chooserCount += 1;
  });

  try {
    await page.goto('/');
    await expect(page.locator('#app h1')).toBeVisible();
    await page.locator('[data-testid="settings-open"]').click();

    const chooserPromise = page.waitForEvent('filechooser');
    await page.locator('[data-testid="local-mode-import"]').click();
    const chooser = await chooserPromise;
    await chooser.setFiles(dir);

    await expect(page.locator('[data-testid="import-progress"]')).toBeHidden({
      timeout: 20_000,
    });
    await page.locator('[data-testid="settings-back"]').click();
    await page.locator('[data-testid="folder-source-local"]').click();
    await expect(page.locator('[data-testid="track-row"]')).toHaveCount(2);

    chooserCount = 0;
    await page.reload();
    await expect(page.locator('#app h1')).toBeVisible();
    await page.locator('[data-testid="folder-source-local"]').click();
    await expect(page.locator('[data-testid="track-row"]')).toHaveCount(2);
    expect(chooserCount).toBe(0);

    await page.locator('[data-testid="track-row"] .row-hit').first().click();
    await expect(page.locator('.player .meta h2')).not.toHaveText('');
    await expect
      .poll(() => page.evaluate(() => document.querySelector('audio')?.paused ?? true))
      .toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.describe('background playback card', () => {
  test.use({ userAgent: ANDROID_UA });

  test('shows install state and the brand-specific battery guide', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-testid="settings-open"]').click();

    await expect(page.locator('[data-testid="settings-section-background"]')).toBeVisible();
    await expect(page.locator('[data-testid="install-status"]')).not.toHaveText('');

    const batteryButton = page.locator('[data-testid="battery-button"]');
    await expect(batteryButton).toBeVisible();
    await batteryButton.click();

    const guide = page.locator('[data-testid="battery-guide"]');
    await expect(guide).toBeVisible();
    const stock = page.locator('[data-testid="battery-brand-stock"]');
    await expect(stock).toHaveAttribute('aria-pressed', 'true');

    const steps = page.locator('[data-testid="battery-steps"]');
    const before = await steps.textContent();
    await page.locator('[data-testid="battery-brand-samsung"]').click();
    await expect(page.locator('[data-testid="battery-brand-samsung"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(steps).not.toHaveText(before ?? '');

    await page.locator('[data-testid="battery-guide-close"]').click();
    await expect(guide).toBeHidden();
  });
});

test('manifest ships two any and two maskable icons with matching PNG sizes', async ({
  request,
}) => {
  const response = await request.get('/manifest.webmanifest');
  expect(response.status()).toBe(200);
  const manifest = await response.json();

  expect(manifest.theme_color).toBe('#f6f5f1');
  expect(manifest.background_color).toBe('#f6f5f1');
  expect(manifest.icons).toHaveLength(4);
  expect(manifest.icons.filter((icon) => icon.purpose === 'any')).toHaveLength(2);
  expect(manifest.icons.filter((icon) => icon.purpose === 'maskable')).toHaveLength(2);

  for (const icon of manifest.icons) {
    const [width, height] = icon.sizes.split('x').map(Number);
    const src = icon.src.startsWith('./') ? `/${icon.src.slice(2)}` : icon.src;
    const png = await request.get(src);
    expect(png.status(), src).toBe(200);
    const body = await png.body();
    expect(body.subarray(1, 4).toString('ascii'), src).toBe('PNG');
    expect(body.readUInt32BE(16), `${src} width`).toBe(width);
    expect(body.readUInt32BE(20), `${src} height`).toBe(height);
  }

  const apple = await request.get('/icons/icon-180.png');
  expect(apple.status()).toBe(200);
  const appleBody = await apple.body();
  expect(appleBody.readUInt32BE(16)).toBe(180);
  expect(appleBody.readUInt32BE(20)).toBe(180);
});

test('play log shows playback events, copies and clears', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: 'http://127.0.0.1:4173',
  });
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: undefined,
    });
  });

  await page.goto('/');
  await expect(page.locator('#app h1')).toBeVisible();
  await seedSingleTrack(page);
  await page.reload();

  await page.locator('[data-testid="folder-source-local"]').click();
  await page.locator('[data-testid="folder-dir-Music"]').click();
  await expect(page.locator('[data-testid="track-row"]')).toHaveCount(1);
  await page.locator('[data-testid="track-row"] .row-hit').first().click();
  await expect
    .poll(() => page.evaluate(() => document.querySelector('audio')?.paused ?? true))
    .toBe(false);

  await page.locator('[data-testid="settings-open"]').click();
  await page.locator('[data-testid="playlog-open"]').click();

  const logText = page.locator('[data-testid="playlog-text"]');
  await expect(logText).toContainText('audio:play');

  await page.locator('[data-testid="playlog-copy"]').click();
  await expect(page.locator('.toast')).toContainText('已复制播放日志');

  await page.locator('[data-testid="playlog-clear"]').click();
  await expect(logText).not.toContainText('audio:play');

  await page.locator('[data-testid="playlog-close"]').click();
  await expect(page.locator('[data-testid="playlog-panel"]')).toBeHidden();
});
