import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { installGraphMock } from './support/graph-mock.js';

mkdirSync('.scratch/conductor/ao', { recursive: true });

const FILES = [{ id: 'track-1', name: 'one.mp3' }];

/**
 * Deterministic File System Access stand-in: a fake IndexedDB seeded with a
 * `dirHandle` and one track, plus a handle whose requestPermission answer is
 * chosen by the spec. `getFile` enforces the fake grant, so a denied request
 * really fails the read.
 */
async function installLocalFakes(page, requestResult) {
  await page.addInitScript((result) => {
    window.__perm = {
      state: { permission: 'prompt' },
      requestResult: result,
      queries: 0,
      requests: 0,
    };

    const sampleRate = 8000;
    const samples = sampleRate;
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
    const audioFile = new File([buffer], 'a.wav', { type: 'audio/wav', lastModified: Date.now() });

    const handle = {
      kind: 'directory',
      name: 'Music',
      async queryPermission() {
        window.__perm.queries += 1;
        return window.__perm.state.permission;
      },
      async requestPermission() {
        window.__perm.requests += 1;
        window.__perm.state.permission = window.__perm.requestResult;
        return window.__perm.requestResult;
      },
      async getFileHandle(name) {
        return {
          kind: 'file',
          name,
          getFile: async () => {
            if (window.__perm.state.permission !== 'granted') {
              throw new DOMException('Permission denied', 'NotAllowedError');
            }
            return audioFile;
          },
        };
      },
      entries: async function* () {},
      getDirectoryHandle: async () => {
        throw new Error('getDirectoryHandle: not stubbed');
      },
    };

    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: async () => {
        throw new Error('showDirectoryPicker: not stubbed');
      },
    });

    const stores = new Map();

    function request(compute) {
      const req = { result: undefined, error: null, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        try {
          req.result = compute();
          if (typeof req.onsuccess === 'function') req.onsuccess({ target: req });
        } catch (error) {
          req.error = error;
          if (typeof req.onerror === 'function') req.onerror({ target: req });
        }
      });
      return req;
    }

    function makeStore(name) {
      const rows = stores.get(Array.isArray(name) ? name[0] : name);
      return {
        get: (key) => request(() => rows.get(key)),
        getAll: () => request(() => Array.from(rows.values())),
        put: (value) =>
          request(() => {
            rows.set(value.key ?? value.id, value);
            return undefined;
          }),
        delete: (key) =>
          request(() => {
            rows.delete(key);
            return undefined;
          }),
        clear: () =>
          request(() => {
            rows.clear();
            return undefined;
          }),
      };
    }

    const db = {
      objectStoreNames: { contains: (name) => stores.has(name) },
      createObjectStore(name) {
        stores.set(name, new Map());
        return { createIndex() {} };
      },
      transaction(name) {
        const store = makeStore(name);
        let complete = null;
        const tx = { objectStore: () => store, onerror: null, onabort: null };
        Object.defineProperty(tx, 'oncomplete', {
          get: () => complete,
          set(fn) {
            complete = fn;
            setTimeout(() => {
              if (typeof fn === 'function') fn();
            }, 0);
          },
        });
        return tx;
      },
    };

    let upgraded = false;
    const factory = {
      open() {
        const req = {
          result: null,
          error: null,
          onsuccess: null,
          onerror: null,
          onupgradeneeded: null,
        };
        setTimeout(() => {
          req.result = db;
          if (!upgraded) {
            upgraded = true;
            if (typeof req.onupgradeneeded === 'function') req.onupgradeneeded({ target: req });
          }
          stores.get('meta').set('dirHandle', { key: 'dirHandle', value: handle });
          stores.get('meta').set('localMode', { key: 'localMode', value: 'reference' });
          stores.get('tracks').set('fsa:a.wav', {
            id: 'fsa:a.wav',
            path: 'a.wav',
            title: 'a',
            artist: '',
            album: '',
            year: null,
            trackNo: null,
            duration: 60,
            mtime: Date.now(),
            size: audioFile.size,
            hasCover: false,
            source: 'fsa',
            externalIds: {},
          });
          if (typeof req.onsuccess === 'function') req.onsuccess({ target: req });
        }, 0);
        return req;
      },
    };
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: factory });
  }, requestResult);
}

async function signInAndPickMusic(page, mock) {
  await page.goto('/');
  await expect(page.locator('.wordmark')).toHaveText('localtune.');

  await page.locator('[data-testid="settings-open"]').click();
  await page.locator('[data-testid="source-connect-onedrive"]').click();

  await expect(page.locator('[data-testid="onedrive-picker"]')).toBeVisible();
  await expect(page.locator('[data-testid="onedrive-folder"]').first()).toHaveText('Music');
  await page.locator('[data-testid="onedrive-folder"]').first().click();
  await page.locator('[data-testid="onedrive-picker-choose"]').click();

  await expect(page.locator('[data-testid="onedrive-picker"]')).toBeHidden();
  // closePicker() precedes rescan, so the row's disabled sync button is the
  // signal that the warm pass (and the lastScan stamp) really finished.
  await expect(page.locator('[data-testid="settings-sync-onedrive"]')).toBeEnabled({
    timeout: 15_000,
  });
  await expect.poll(() => mock.wholeRequests.length, { timeout: 10_000 }).toBe(1);
}

test('denied local permission opens the dialog and settings lands on the source', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await installLocalFakes(page, 'denied');
  await page.goto('/');
  await expect(page.locator('#status')).toBeHidden();

  await page.locator('[data-testid="folder-source-local"]').click();
  await page.locator('[data-testid="track-row"] .track').first().click();

  const dialog = page.locator('[data-testid="permission-dialog"]');
  await expect(dialog).toBeVisible();
  await expect(page.locator('[data-testid="permission-title"]')).toContainText(
    '无法读取本地文件夹',
  );
  await expect(page.locator('[data-testid="permission-reauthorize"]')).toBeVisible();
  await expect(page.locator('[data-testid="permission-settings"]')).toBeVisible();
  await expect(page.locator('[data-testid="permission-close"]')).toBeVisible();
  expect(await page.evaluate(() => window.__perm.requests)).toBe(1);

  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 740 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await page.screenshot({ path: `.scratch/conductor/ao/permission-${width}.png` });
  }
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.locator('[data-testid="permission-settings"]').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('[data-testid="settings-section-library"]')).toBeVisible();
  await expect(page.locator('[data-testid="source-row-local"]')).toBeVisible();
});

test('granted local permission recovers and plays on the retry', async ({ page }) => {
  test.setTimeout(120_000);
  await installLocalFakes(page, 'granted');
  await page.goto('/');
  await expect(page.locator('#status')).toBeHidden();

  await page.locator('[data-testid="folder-source-local"]').click();
  await page.locator('[data-testid="track-row"] .track').first().click();

  await expect(page.locator('#armRotor')).toHaveAttribute('data-playing', 'true');
  await expect(page.locator('[data-testid="permission-dialog"]')).toBeHidden();
  expect(await page.evaluate(() => window.__perm.requests)).toBe(1);
});

test('a 401 download URL refreshes the OneDrive token and plays', async ({ page }) => {
  test.setTimeout(120_000);
  const mock = await installGraphMock(page, { files: FILES });

  await signInAndPickMusic(page, mock);
  await page.reload();
  await expect(page.locator('.wordmark')).toHaveText('localtune.');
  await page.evaluate(() => caches.delete('audio-v1'));
  const refreshes = mock.tokenRefreshes;

  await page.locator('[data-testid="folder-source-onedrive"]').click();
  await expect(page.locator('[data-testid="track-row"]')).toHaveCount(1);
  mock.failDownloadUrlTimes = 2;
  await page.locator('[data-testid="track-row"] .track').first().click();

  await expect.poll(() => mock.tokenRefreshes).toBeGreaterThan(refreshes);
  await expect(page.locator('[data-testid="permission-dialog"]')).toBeHidden();
  await expect(page.locator('#armRotor')).toHaveAttribute('data-playing', 'true');
});

test('a rejected OneDrive refresh keeps the dialog open', async ({ page }) => {
  test.setTimeout(120_000);
  const mock = await installGraphMock(page, { files: FILES, failTokenRefresh: true });

  await signInAndPickMusic(page, mock);
  await page.reload();
  await expect(page.locator('.wordmark')).toHaveText('localtune.');
  await page.evaluate(() => caches.delete('audio-v1'));

  await page.locator('[data-testid="folder-source-onedrive"]').click();
  await expect(page.locator('[data-testid="track-row"]')).toHaveCount(1);
  mock.failDownloadUrlTimes = 2;
  await page.locator('[data-testid="track-row"] .track').first().click();

  await expect(page.locator('[data-testid="permission-dialog"]')).toBeVisible();
  await expect(page.locator('[data-testid="permission-title"]')).toContainText('OneDrive');
  expect(mock.tokenRefreshes).toBe(0);
});
