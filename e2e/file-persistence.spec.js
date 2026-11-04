import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'http://127.0.0.1:4173';
const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'tests',
  'fixtures',
  'cjk-gbk-v2.mp3',
);

// Verifies the `<input webkitdirectory>` fallback across a browser restart: the
// File objects we store in IndexedDB must still be readable next launch.
test('input-origin File survives a restart', async () => {
  test.setTimeout(120_000);

  const userDataDir = await mkdtemp(path.join(tmpdir(), 'localtune-profile-'));
  const musicDir = await mkdtemp(path.join(tmpdir(), 'localtune-music-'));
  await copyFile(FIXTURE, path.join(musicDir, 'cjk-gbk-v2.mp3'));

  let context = null;
  try {
    // ---- first launch: pick a real file, persist the File object ----
    context = await chromium.launchPersistentContext(userDataDir, { headless: true });
    let page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${ORIGIN}/manifest.webmanifest`);
    await page.setContent('<input id="f" type="file" webkitdirectory multiple>');
    await page.setInputFiles('#f', musicDir);

    const saved = await page.evaluate(async () => {
      const file = document.getElementById('f').files[0];
      if (!file) throw new Error('webkitdirectory input produced no files');
      const path = file.webkitRelativePath || file.name;
      const info = { name: file.name, size: file.size, type: file.type, path };
      await new Promise((resolve, reject) => {
        const open = indexedDB.open('localtune-file-test', 1);
        open.onupgradeneeded = () => {
          open.result.createObjectStore('files', { keyPath: 'path' });
        };
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('files', 'readwrite');
          tx.objectStore('files').put({ path, file });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      });
      return info;
    });
    expect(saved.path).toBe(`${path.basename(musicDir)}/cjk-gbk-v2.mp3`);
    expect(saved.size).toBeGreaterThan(0);
    await context.close();
    context = null;

    // ---- second launch: same profile, read the File back ----
    context = await chromium.launchPersistentContext(userDataDir, { headless: true });
    page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${ORIGIN}/manifest.webmanifest`);

    const read = await page.evaluate(async () => {
      try {
        const row = await new Promise((resolve, reject) => {
          const open = indexedDB.open('localtune-file-test', 1);
          open.onupgradeneeded = () => {
            open.result.createObjectStore('files', { keyPath: 'path' });
          };
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction('files', 'readonly');
            const all = tx.objectStore('files').getAll();
            all.onsuccess = () => resolve(all.result[0] ?? null);
            all.onerror = () => reject(all.error);
          };
        });
        if (!row) return { error: 'no row in IndexedDB' };
        const buffer = await row.file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        return {
          byteLength: bytes.byteLength,
          name: row.file.name,
          type: row.file.type,
          first3: Array.from(bytes.slice(0, 3)),
        };
      } catch (error) {
        return { error: `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}` };
      }
    });

    const unreadable =
      read.error !== undefined ||
      read.byteLength !== saved.size ||
      read.name !== saved.name ||
      read.type !== saved.type;
    if (unreadable) {
      test.fail(
        true,
        `File from <input webkitdirectory> is not reliably readable after a restart: ${JSON.stringify(read)}`,
      );
    }

    expect(read.byteLength).toBe(saved.size);
    expect(read.name).toBe(saved.name);
    expect(read.type).toBe(saved.type);
    expect(read.first3).toEqual([0x49, 0x44, 0x33]); // "ID3"
  } finally {
    await context?.close().catch(() => {});
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    await rm(musicDir, { recursive: true, force: true }).catch(() => {});
  }
});
