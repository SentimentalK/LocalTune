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
    await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open('localtune');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('meta', 'readwrite');
            tx.objectStore('meta').put({ key: 'localMode', value: 'import' });
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
        }),
    );
    await page.reload();
    await expect(page.locator('#app h1')).toBeVisible();
    await page.locator('[data-testid="settings-open"]').click();

    const chooserPromise = page.waitForEvent('filechooser');
    await page.locator('[data-testid="source-connect-local"]').click();
    const chooser = await chooserPromise;
    await chooser.setFiles(dir);

    await expect(page.locator('[data-testid="import-progress"]')).toBeHidden({
      timeout: 20_000,
    });
    await page.locator('[data-testid="settings-close"]').click();
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

    // Removing an OPFS source must delete the imported copies, not just the
    // index: there is no other UI left that could free that space.
    await page.locator('[data-testid="settings-open"]').click();
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('[data-testid="settings-source-remove"]').click();

    await expect(page.locator('[data-testid="source-connect-local"]')).toBeVisible();
    const opfs = await page.evaluate(async () => {
      const base = await navigator.storage.getDirectory();
      try {
        await base.getDirectoryHandle('music', { create: false });
        return { folderExists: true, files: 0 };
      } catch {
        return { folderExists: false, files: 0 };
      }
    });
    expect(opfs.folderExists).toBe(false);

    await page.locator('[data-testid="settings-close"]').click();
    await expect(page.locator('[data-testid="folder-source-local"]')).toHaveCount(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.describe('background playback card', () => {
  test.use({ userAgent: ANDROID_UA });

  test('shows install state and two-column battery steps', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-testid="settings-open"]').click();

    await expect(page.locator('[data-testid="settings-section-background"]')).toBeVisible();
    await expect(page.locator('[data-testid="install-status"]')).not.toHaveText('');

    const grid = page.locator('[data-testid="background-grid"]');
    await expect(grid).toBeVisible();
    const layout = await grid.evaluate((node) => {
      const [left, right] = node.children;
      const a = left.getBoundingClientRect();
      const b = right.getBoundingClientRect();
      return {
        childCount: node.children.length,
        topDelta: Math.abs(a.top - b.top),
        gap: b.left - a.right,
        overflow: node.scrollWidth - node.clientWidth,
      };
    });
    expect(layout.childCount).toBe(2);
    expect(layout.topDelta).toBeLessThan(2);
    expect(layout.gap).toBeGreaterThan(-4);
    expect(layout.overflow).toBeLessThanOrEqual(0);

    const stockList = page.locator('[data-testid="battery-steps-stock-list"]');
    await expect(stockList).toBeVisible();
    await expect(stockList.locator('li')).toHaveCount(3);

    const samsung = page.locator('[data-testid="battery-brand-details-samsung"]');
    await expect(samsung).toBeVisible();
    await expect(samsung.locator('ol')).toBeHidden();
    await samsung.locator('summary').click();
    await expect(samsung.locator('ol')).toBeVisible();

    const batteryButton = page.locator('[data-testid="battery-button"]');
    await expect(batteryButton).toBeVisible();
    await batteryButton.click();
    const details = page.locator('[data-testid="battery-steps-section"] details');
    await expect(details).toHaveCount(3);
    for (let index = 0; index < 3; index += 1) {
      await expect(details.nth(index)).toHaveAttribute('open', '');
    }
  });

  test('keeps the copy and actions side by side at 360px', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto('/');
    await page.locator('[data-testid="settings-open"]').click();

    const grid = page.locator('[data-testid="background-grid"]');
    await expect(grid).toBeVisible();
    const layout = await grid.evaluate((node) => {
      const [left, right] = node.children;
      const a = left.getBoundingClientRect();
      const b = right.getBoundingClientRect();
      return {
        childCount: node.children.length,
        topDelta: Math.abs(a.top - b.top),
        gap: b.left - a.right,
        overflow: node.scrollWidth - node.clientWidth,
      };
    });
    expect(layout.childCount).toBe(2);
    expect(layout.topDelta).toBeLessThan(2);
    expect(layout.gap).toBeGreaterThanOrEqual(-4);
    expect(layout.overflow).toBeLessThanOrEqual(0);
  });

  test('hides the install button once the app runs installed', async ({ page }) => {
    await page.addInitScript(() => {
      const real = window.matchMedia?.bind(window);
      window.matchMedia = (query) => {
        if (query === '(display-mode: standalone)') {
          return {
            matches: true,
            media: query,
            addEventListener() {},
            removeEventListener() {},
            addListener() {},
            removeListener() {},
          };
        }
        return real
          ? real(query)
          : {
              matches: false,
              media: query,
              addEventListener() {},
              removeEventListener() {},
              addListener() {},
              removeListener() {},
            };
      };
    });

    await page.goto('/');
    await page.locator('[data-testid="settings-open"]').click();
    await expect(page.locator('[data-testid="settings-section-background"]')).toBeVisible();
    await expect(page.locator('[data-testid="install-button"]')).toBeHidden();
    await expect(page.locator('[data-testid="install-status"]')).not.toHaveText('');
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
