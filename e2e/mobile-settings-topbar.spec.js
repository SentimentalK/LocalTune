import { expect, test } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test.use({
  locale: 'en-US',
  launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] },
});

const SHOTS = '.scratch/conductor/ae';
const FILES = 24;

/** A 16-bit mono PCM WAV of silence; 44-byte RIFF header, no metadata. */
function wavBuffer() {
  const samples = 800;
  const bytes = 44 + samples * 2;
  const buffer = Buffer.alloc(bytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(bytes - 8, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
}

/** Slow OPFS writes so the import copy pass stays observable. */
function slowOpfsWrites(page) {
  return page.addInitScript(() => {
    const proto = globalThis.FileSystemFileHandle?.prototype;
    if (!proto || proto.__slow) return;
    const original = proto.createWritable;
    Object.defineProperty(proto, '__slow', { value: true });
    proto.createWritable = async function createWritable(...args) {
      const writable = await original.apply(this, args);
      const write = writable.write.bind(writable);
      writable.write = async (chunk) => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return write(chunk);
      };
      return writable;
    };
  });
}

async function makeImportDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'localtune-topbar-'));
  const wav = wavBuffer();
  for (let index = 0; index < FILES; index += 1) {
    await writeFile(path.join(dir, `track-${String(index).padStart(2, '0')}.wav`), wav);
  }
  return dir;
}

function switchToImportMode(page) {
  return page.evaluate(
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
}

async function boxOf(locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box;
}

/** The centre of `selector` must hit itself or one of its descendants. */
function hitsSelf(page, selector) {
  return page.evaluate((sel) => {
    const node = document.querySelector(sel);
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return Boolean(hit && (hit === node || node.contains(hit)));
  }, selector);
}

for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 740 }]) {
  test(`mobile settings keeps the top bar at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.locator('.wordmark')).toBeVisible();
    await page.locator('[data-testid="settings-open"]').click();
    await expect(page.locator('[data-testid="settings-section-playback"]')).toBeVisible();

    const topbar = page.locator('.topbar');
    const wordmark = page.locator('.wordmark');
    const settingsButton = page.locator('[data-testid="settings-open"]');
    await expect(topbar).toBeVisible();
    await expect(wordmark).toBeVisible();

    const barBox = await boxOf(topbar);
    const markBox = await boxOf(wordmark);
    expect(barBox.y).toBeGreaterThanOrEqual(0);
    expect(markBox.y + markBox.height).toBeLessThanOrEqual(viewport.height);

    const headBox = await boxOf(page.locator('.panel-head'));
    expect(headBox.y).toBeGreaterThanOrEqual(barBox.y + barBox.height);

    await expect(page.locator('#settingsKicker')).toHaveCount(0);
    await expect(page.locator('[data-testid="settings-close"]')).toHaveCount(0);

    expect(await topbar.evaluate((node) => node.inert)).toBe(false);
    expect(await settingsButton.evaluate((node) => node.inert)).toBe(false);
    expect(await hitsSelf(page, '.wordmark')).toBe(true);
    expect(await hitsSelf(page, '[data-testid="settings-open"]')).toBe(true);

    await expect(settingsButton).toHaveAttribute('aria-expanded', 'true');
    await settingsButton.click();
    await expect(settingsButton).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('[data-testid="settings-section-playback"]')).toBeHidden();
    await settingsButton.click();
    await expect(settingsButton).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('[data-testid="settings-section-playback"]')).toBeVisible();

    await page.screenshot({ path: `${SHOTS}/ae-settings-${viewport.width}.png` });
  });
}

test('an import reports progress in the top bar while settings is open', async ({ page }) => {
  test.setTimeout(120_000);
  const dir = await makeImportDir();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await slowOpfsWrites(page);
    await page.goto('/');
    await expect(page.locator('.wordmark')).toBeVisible();
    await switchToImportMode(page);
    await page.reload();
    await page.locator('[data-testid="settings-open"]').click();
    await expect(page.locator('[data-testid="settings-section-playback"]')).toBeVisible();

    const chooserPromise = page.waitForEvent('filechooser');
    await page.locator('[data-testid="source-connect-local"]').click();
    const chooser = await chooserPromise;
    await chooser.setFiles(dir);

    const status = page.locator('#status');
    await expect(status).toBeVisible({ timeout: 15_000 });
    await expect(status).toContainText(/Importing \d+ \/ \d+/);
    const first = await status.textContent();

    const statusBox = await boxOf(status);
    expect(statusBox.y).toBeGreaterThanOrEqual(0);
    expect(statusBox.y + statusBox.height).toBeLessThanOrEqual(844);
    expect(await hitsSelf(page, '#status')).toBe(true);
    expect(
      await page.evaluate(() => {
        const node = document.querySelector('#status');
        const rect = node.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return Boolean(hit?.closest('.topbar'));
      }),
    ).toBe(true);

    await page.screenshot({ path: `${SHOTS}/ae-import-390.png` });

    const seen = new Set([first]);
    await expect
      .poll(
        async () => {
          seen.add(await status.textContent());
          return seen.size;
        },
        { timeout: 30_000, intervals: [50, 100] },
      )
      .toBeGreaterThanOrEqual(2);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('desktop keeps the settings panel as a sidebar', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await page.locator('[data-testid="settings-open"]').click();
  await expect(page.locator('[data-testid="settings-section-playback"]')).toBeVisible();

  const position = await page.locator('#panel').evaluate((node) => getComputedStyle(node).position);
  expect(position).toBe('sticky');
  await expect(page.locator('[data-testid="settings-close"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="settings-open"]')).toHaveAttribute('aria-expanded', 'true');
  await page.screenshot({ path: `${SHOTS}/ae-desktop-settings-1280.png` });
});
