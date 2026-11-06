import { expect, test } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test.use({
  locale: 'en-US',
  launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] },
});

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

/**
 * OPFS writes are fast enough that a 24-file import can finish between two
 * assertions; slowing `createWritable` keeps the copy pass observable without
 * touching app code.
 */
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
        await new Promise((resolve) => setTimeout(resolve, 30));
        return write(chunk);
      };
      return writable;
    };
  });
}

async function makeImportDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'localtune-progress-'));
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

test('an OPFS import reports progress only in the header', async ({ page }) => {
  test.setTimeout(90_000);
  const dir = await makeImportDir();
  try {
    await page.setViewportSize({ width: 360, height: 780 });
    await slowOpfsWrites(page);
    await page.goto('/');
    await expect(page.locator('.wordmark')).toBeVisible();
    await switchToImportMode(page);
    await page.reload();
    await expect(page.locator('.wordmark')).toBeVisible();
    await page.locator('[data-testid="settings-open"]').click();

    // There is exactly one progress surface for an import: the header.
    await expect(page.locator('[data-testid="import-progress"]')).toHaveCount(0);

    const chooserPromise = page.waitForEvent('filechooser');
    await page.locator('[data-testid="source-connect-local"]').click();
    const chooser = await chooserPromise;
    await chooser.setFiles(dir);

    await expect(page.locator('#status')).toContainText('Importing', { timeout: 15_000 });
    // The source card must not repeat the import figure next to the header.
    await expect(
      page.locator('[data-testid="settings-library-local"] .settings-progress'),
    ).toBeHidden();

    // Progress is text next to the wordmark; there is no green bar.
    await expect(page.locator('[data-testid="scan-progress"]')).toHaveCount(0);
    const statusText = await page.locator('#status').textContent();
    expect(statusText).toMatch(/Importing \d+ \/ \d+/);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: 'test-results/import-progress-360.png' });

    await expect(page.locator('#status')).toBeHidden({ timeout: 30_000 });
    await page.locator('[data-testid="settings-open"]').click();
    await page.locator('[data-testid="folder-source-local"]').click();
    await expect(page.locator('[data-testid="track-row"]')).toHaveCount(FILES);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
