// End-to-end update flow: a waiting service worker activates on its own when
// the page is idle, and stays behind the banner while audio plays. Two builds
// of the same sources with different BUILD_LABELs are served from one origin,
// so the browser sees a real update.

import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { startStaticServer } from './support/static-server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = path.join(root, '.scratch', 'e2e-update');

test.use({
  launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] },
});

test.describe.configure({ mode: 'serial' });

let server;
let v1Root;
let v2Root;
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

async function waitForActiveWorker(page) {
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.active?.state === 'activated';
  });
}

async function waitForVersion(page, version) {
  await page.waitForFunction(
    async (expected) => {
      if (!navigator.serviceWorker.controller) return false;
      try {
        const text = await (await fetch('./sw.js')).text();
        return text.includes(expected);
      } catch {
        return false;
      }
    },
    version,
    { timeout: 20000 },
  );
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

  v1Root = path.join(root, v1Dir);
  v2Root = path.join(root, v2Dir);
  server = await startStaticServer({ root: v1Root });
});

test.afterAll(async () => {
  await server?.close();
});

test('fresh load auto-activates the waiting worker and reloads once', async ({ page }) => {
  server.setRoot(v1Root);
  await page.goto(`${server.url}/`);
  await waitForActiveWorker(page);

  // One reload while online guarantees the navigation is SW-controlled.
  await page.reload();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));

  server.setRoot(v2Root);

  const reloaded = page.waitForEvent('load', { timeout: 20000 });
  // The auto-activation may destroy this context mid-evaluate: that is the
  // reload we are waiting for.
  await page
    .evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()))
    .catch(() => {});
  await reloaded;

  await waitForVersion(page, v2Version);

  const state = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return {
      pathname: location.pathname,
      search: location.search,
      bannerVisible: !document.querySelector('.update-banner')?.hidden,
      waiting: Boolean(registration?.waiting),
      reloadFlag: sessionStorage.getItem('localtune:reloading'),
    };
  });

  // Exactly one navigation: the version self-heal saw our own reload marker.
  expect(state.pathname).toBe('/');
  expect(state.search).toBe('');
  expect(state.bannerVisible, JSON.stringify(state)).toBe(false);
  expect(state.waiting, JSON.stringify(state)).toBe(false);
  expect(state.reloadFlag).toBeNull();
});

test('keeps the banner while audio is playing', async ({ page }) => {
  server.setRoot(v1Root);
  await page.goto(`${server.url}/`);
  await waitForActiveWorker(page);

  await page.locator('.track-item.queue').first().click();
  await expect(page.locator('#armRotor')).toHaveAttribute('data-playing', 'true');

  server.setRoot(v2Root);
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));

  await expect(page.locator('.update-banner')).toBeVisible({ timeout: 15000 });

  // Playback must not be interrupted by an automatic reload.
  await page.evaluate(() => {
    window.__probe = 1;
  });
  await page.waitForTimeout(2000);
  expect(await page.evaluate(() => window.__probe)).toBe(1);

  const reloaded = page.waitForEvent('load', { timeout: 20000 });
  await page.locator('[data-testid="update-apply"]').click({ noWaitAfter: true });
  await reloaded;

  await waitForVersion(page, v2Version);
  await expect(page.locator('.update-banner')).toBeHidden();
  expect(new URL(page.url()).search).toBe('');
});
