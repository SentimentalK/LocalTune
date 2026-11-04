import { expect, test } from '@playwright/test';

// Deterministic, offline substitute for a real File System Access handle:
// a fake IndexedDB pre-seeded with a `dirHandle` and counters on
// `window.__perm`. Everything the app touches is implemented; anything else
// is intentionally absent so accidental picker calls fail loudly.
async function installFakes(page, permission) {
  await page.addInitScript((initialPermission) => {
    window.__perm = {
      query: 0,
      request: 0,
      picker: 0,
      state: { permission: initialPermission },
    };

    const handle = {
      kind: 'directory',
      name: 'Music',
      async queryPermission() {
        window.__perm.query += 1;
        return window.__perm.state.permission;
      },
      async requestPermission() {
        window.__perm.request += 1;
        window.__perm.state.permission = 'granted';
        return 'granted';
      },
      entries: async function* () {},
      getFileHandle: async () => {
        throw new Error('getFileHandle: not stubbed');
      },
      getDirectoryHandle: async () => {
        throw new Error('getDirectoryHandle: not stubbed');
      },
    };

    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: async () => {
        window.__perm.picker += 1;
        window.__perm.state.permission = 'granted';
        return handle;
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
      const rows = stores.get(name);
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
          if (typeof req.onsuccess === 'function') req.onsuccess({ target: req });
        }, 0);
        return req;
      },
    };
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: factory });
  }, permission);
}

test('granted at startup does not prompt', async ({ page }) => {
  await installFakes(page, 'granted');
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('准备就绪');

  const counters = await page.evaluate(() => ({
    query: window.__perm.query,
    request: window.__perm.request,
    picker: window.__perm.picker,
  }));
  expect(counters.query).toBeGreaterThan(0);
  expect(counters.request).toBe(0);
  expect(counters.picker).toBe(0);
  await expect(page.locator('.source-name')).toHaveText('Music');
});

test('prompt uses only requestPermission', async ({ page }) => {
  await installFakes(page, 'prompt');
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('准备就绪');

  const action = page.locator('.empty button');
  await expect(action).toHaveText('继续使用 Music');
  await expect(page.locator('.empty p').filter({ hasText: '每次访问时允许' })).toBeVisible();

  // Not installed + installable: the hint is added without an install button.
  await page.evaluate(() => window.dispatchEvent(new Event('beforeinstallprompt')));
  await expect(
    page.locator('.empty p').filter({ hasText: '安装为应用后，授权会自动记住。' }),
  ).toBeVisible();

  await action.click();
  await expect(page.locator('.source-name')).toHaveText('Music');

  const counters = await page.evaluate(() => ({
    request: window.__perm.request,
    picker: window.__perm.picker,
  }));
  expect(counters).toEqual({ request: 1, picker: 0 });
});
