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
    await expect(page.locator('.wordmark')).toBeVisible();
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
    await expect(page.locator('.wordmark')).toBeVisible();
    await page.locator('[data-testid="settings-open"]').click();

    const chooserPromise = page.waitForEvent('filechooser');
    await page.locator('[data-testid="source-connect-local"]').click();
    const chooser = await chooserPromise;
    await chooser.setFiles(dir);

    await expect(page.locator('[data-testid="scan-progress"]')).toBeHidden({
      timeout: 20_000,
    });
    await page.locator('[data-testid="panel-open"]').click();
    await page.locator('[data-testid="folder-source-local"]').click();
    await expect(page.locator('[data-testid="track-row"]')).toHaveCount(2);

    chooserCount = 0;
    await page.reload();
    await expect(page.locator('.wordmark')).toBeVisible();
    await page.locator('[data-testid="folder-source-local"]').click();
    await expect(page.locator('[data-testid="track-row"]')).toHaveCount(2);
    expect(chooserCount).toBe(0);

    await page.locator('[data-testid="track-row"] .track').first().click();
    await expect(page.locator('.song')).not.toHaveText('');
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

    await page.locator('[data-testid="panel-open"]').click();
    await expect(page.locator('[data-testid="folder-source-local"]')).toHaveCount(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.describe('background playback card', () => {
  test.use({ userAgent: ANDROID_UA, locale: 'en-US' });

  test('offers install and a manual battery check, with no OEM brands', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-testid="settings-open"]').click();

    const card = page.locator('[data-testid="settings-section-background"]');
    await expect(card).toBeVisible();

    const install = page.locator('[data-testid="install-button"]');
    const battery = page.locator('[data-testid="battery-button"]');
    await expect(install).toBeVisible();
    await expect(install).toBeEnabled();
    await expect(install).toHaveText('How to install');
    await expect(battery).toBeVisible();
    await expect(battery).toHaveText('Check settings');
    await expect(battery).toBeEnabled();
    await expect(page.locator('[data-testid="install-status"]')).toHaveText(
      'This browser cannot install the app; playback may stop when the screen is off.',
    );
    await expect(page.locator('[data-testid="background-desktop"]')).toBeHidden();

    const text = await page.locator('body').innerText();
    expect(text).not.toMatch(/Samsung|Xiaomi|Huawei|MIUI|One UI|EMUI/);
    await expect(page.locator('details')).toHaveCount(0);
    await expect(page.locator('[data-testid="battery-steps-section"]')).toHaveCount(0);
    expect(text).not.toMatch(/Battery: OK/);
  });

  test('a standalone launch disables install and survives a reload', async ({ page }) => {
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
        return real ? real(query) : { matches: false, media: query, addEventListener() {}, removeEventListener() {} };
      };
      Object.defineProperty(window.navigator, 'standalone', { configurable: true, value: true });
    });

    for (const pass of ['first load', 'after reload']) {
      await page.goto('/');
      await page.locator('[data-testid="settings-open"]').click();
      const install = page.locator('[data-testid="install-button"]');
      await expect(install, pass).toBeDisabled();
      await expect(install, pass).toHaveText('Installed');
      await expect(install, pass).toHaveAttribute('aria-disabled', 'true');
      await expect(page.locator('[data-testid="install-status"]'), pass).toHaveText(
        'Open LocalTune from your home screen.',
      );
      await expect(page.locator('[data-testid="battery-button"]'), pass).toBeEnabled();
    }
  });

  test('the appinstalled event greys the button in the same session', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-testid="settings-open"]').click();
    const install = page.locator('[data-testid="install-button"]');
    await expect(install).toBeEnabled();

    await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
    await expect(install).toBeDisabled();
    await expect(install).toHaveText('Installed');
  });

  test('the install button calls the captured prompt and turns Installed', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-testid="settings-open"]').click();
    await page.evaluate(() => {
      window.__prompted = 0;
      const event = new Event('beforeinstallprompt');
      event.prompt = async () => {
        window.__prompted += 1;
      };
      event.userChoice = Promise.resolve({ outcome: 'accepted' });
      window.dispatchEvent(event);
    });

    const install = page.locator('[data-testid="install-button"]');
    await expect(install).toHaveText('Install app');
    await install.click();
    await expect(install).toHaveText('Installed');
    await expect(install).toBeDisabled();
    expect(await page.evaluate(() => window.__prompted)).toBe(1);
  });

  test('the card keeps no horizontal overflow at 360px', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto('/');
    await page.locator('[data-testid="settings-open"]').click();

    const overflow = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="settings-section-background"]');
      const actions = document.querySelector('[data-testid="background-actions"]');
      return {
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        card: card.scrollWidth - card.clientWidth,
        actions: actions.scrollWidth - actions.clientWidth,
      };
    });
    expect(overflow.page).toBeLessThanOrEqual(0);
    expect(overflow.card).toBeLessThanOrEqual(0);
    expect(overflow.actions).toBeLessThanOrEqual(0);
  });
});

test.describe('background card on desktop', () => {
  test.use({ locale: 'en-US' });

  test('shows only the phone-only sentence', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-testid="settings-open"]').click();
    await expect(page.locator('[data-testid="background-desktop"]')).toHaveText(
      'Background playback applies to phones.',
    );
    await expect(page.locator('[data-testid="background-actions"]')).toBeHidden();
    await expect(page.locator('[data-testid="install-button"]')).toBeHidden();
    await expect(page.locator('[data-testid="battery-button"]')).toBeHidden();
    await expect(page.locator('[data-testid="install-status"]')).toBeHidden();
    await expect(page.locator('[data-testid="background-body"]')).toBeHidden();
  });

  test('the sentence does not overflow at 360px', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto('/');
    await page.locator('[data-testid="settings-open"]').click();
    const note = page.locator('[data-testid="background-desktop"]');
    await expect(note).toBeVisible();
    const overflow = await note.evaluate((node) => node.scrollWidth - node.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const pageOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(pageOverflow).toBeLessThanOrEqual(0);
  });
});

test('manifest ships two any and two maskable icons with matching PNG sizes', async ({
  request,
}) => {
  const response = await request.get('/manifest.webmanifest');
  expect(response.status()).toBe(200);
  const manifest = await response.json();

  // Install-time only: the system bakes these in and never follows a theme
  // switch. Both take the deepest palette (Obsidian) so every theme sits as
  // close as possible to the system chrome.
  expect(manifest.theme_color).toBe('#0a0a0b');
  expect(manifest.background_color).toBe('#0a0a0b');
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
