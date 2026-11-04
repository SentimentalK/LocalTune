import { expect, test } from '@playwright/test';

// Collect page-level noise once per test; async errors settle by the time the
// SW is ready, so asserting at the end catches late failures too.
function pageErrors(page) {
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

async function waitForServiceWorker(page) {
  // `navigator.serviceWorker.ready` can resolve while the worker is still
  // 'activating'; wait for the terminal state before touching the page again.
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.active?.state === 'activated';
  });
  return page.evaluate(() =>
    navigator.serviceWorker.ready.then((registration) => registration.active?.state ?? null),
  );
}

// A network failure while the context is offline is expected; the SW must
// answer from cache.
const expectedOffline = /ERR_INTERNET_DISCONNECTED|ERR_FAILED|Failed to fetch/i;

test('shell renders without console errors', async ({ page }) => {
  const errors = pageErrors(page);

  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  await expect(page.locator('#app h1')).toHaveText('LocalTune');
  await expect(page.locator('#status')).toHaveText('准备就绪');
  expect(await waitForServiceWorker(page)).toBe('activated');

  expect(errors).toEqual([]);
});

test('manifest is served and well-formed', async ({ request }) => {
  const response = await request.get('/manifest.webmanifest');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('application/manifest+json');

  const manifest = await response.json();
  expect(manifest.name).toBe('LocalTune');
  expect(manifest.start_url).toBe('./');
  expect(manifest.scope).toBe('./');
  expect(manifest.display).toBe('standalone');

  const sizes = manifest.icons.map((icon) => icon.sizes);
  expect(sizes).toContain('192x192');
  expect(sizes).toContain('512x512');
  expect(manifest.icons.some((icon) => icon.purpose === 'maskable')).toBe(true);
});

test('service worker becomes ready and controls the page', async ({ page }) => {
  const errors = pageErrors(page);

  await page.goto('/');
  expect(await waitForServiceWorker(page)).toBe('activated');

  await page.reload();
  expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await expect(page.locator('#app h1')).toHaveText('LocalTune');

  expect(errors).toEqual([]);
});

test('offline reload is served from the precache', async ({ page, context }) => {
  const errors = pageErrors(page);

  await page.goto('/');
  expect(await waitForServiceWorker(page)).toBe('activated');
  // One reload while online guarantees the navigation is SW-controlled.
  await page.reload();
  await expect(page.locator('#app h1')).toHaveText('LocalTune');

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#app')).toContainText('LocalTune');
  await context.setOffline(false);

  expect(errors.filter((error) => !expectedOffline.test(error))).toEqual([]);
});
