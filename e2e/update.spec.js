// End-to-end update flow: a waiting service worker must activate on demand and
// reload the page exactly once. Two builds of the same sources with different
// BUILD_LABELs are served from one origin, so the browser sees a real update.

import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { startStaticServer } from './support/static-server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = path.join(root, '.scratch', 'e2e-update');

test.describe.configure({ mode: 'serial' });

let server;
let v2Version;

function build(label, outDir) {
  execFileSync(process.execPath, ['scripts/build.mjs', '--out', outDir], {
    cwd: root,
    env: { ...process.env, BUILD_LABEL: label },
    encoding: 'utf8',
  });
}

function versionOf(outDir) {
  const sw = readFileSync(path.join(root, outDir, 'sw.js'), 'utf8');
  const match = sw.match(/const VERSION = '([0-9a-f]{10})'/);
  if (!match) throw new Error(`no VERSION in ${outDir}/sw.js`);
  return match[1];
}

test.beforeAll(async () => {
  rmSync(scratch, { recursive: true, force: true });
  const v1Dir = path.relative(root, path.join(scratch, 'v1'));
  const v2Dir = path.relative(root, path.join(scratch, 'v2'));
  build('v1', v1Dir);
  build('v2', v2Dir);

  const v1Version = versionOf(v1Dir);
  v2Version = versionOf(v2Dir);
  expect(v1Version).not.toBe(v2Version);

  server = await startStaticServer({ root: path.join(root, v1Dir) });
  server.v2Root = path.join(root, v2Dir);
});

test.afterAll(async () => {
  await server?.close();
});

test('applies the waiting worker and reloads only once', async ({ page }) => {
  await page.goto(`${server.url}/`);
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.active?.state === 'activated';
  });

  // One reload while online guarantees the navigation is SW-controlled.
  await page.reload();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));

  server.setRoot(server.v2Root);
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));

  const banner = page.locator('.update-banner');
  await expect(banner).toBeVisible({ timeout: 15000 });

  const reloaded = page.waitForEvent('load', { timeout: 20000 });
  await page.locator('[data-testid="update-apply"]').click({ noWaitAfter: true });
  await reloaded;

  // The controller now serves v2's sw.js (network-first, so this is the build
  // the active worker was created from).
  await page.waitForFunction(
    async (version) => {
      if (!navigator.serviceWorker.controller) return false;
      try {
        const text = await (await fetch('./sw.js')).text();
        return text.includes(version);
      } catch {
        return false;
      }
    },
    v2Version,
    { timeout: 20000 },
  );

  const state = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    const scriptURL = navigator.serviceWorker.controller?.scriptURL ?? null;
    let servedVersion = null;
    try {
      const text = await (await fetch('./sw.js')).text();
      servedVersion = text.match(/const VERSION = '([0-9a-f]{10})'/)?.[1] ?? null;
    } catch {
      // ignore: reported as null below
    }
    return {
      bannerVisible: !document.querySelector('.update-banner')?.hidden,
      waiting: Boolean(registration?.waiting),
      controller: scriptURL,
      search: scriptURL ? new URL(scriptURL).search : null,
      servedVersion,
      reloadFlag: sessionStorage.getItem('localtune:reloading'),
    };
  });

  // Banner must be gone after the reload that activated the new worker.
  expect(state.bannerVisible, JSON.stringify(state)).toBe(false);
  expect(state.waiting, JSON.stringify(state)).toBe(false);
  expect(state.controller).not.toBeNull();
  expect(state.search).toBe('');
  expect(state.reloadFlag).toBeNull();

  // A further reload must not resurrect it (the old loop showed it every time).
  await page.reload();
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.active?.state === 'activated' && Boolean(navigator.serviceWorker.controller);
  });
  await expect(page.locator('.update-banner')).toBeHidden();
});
