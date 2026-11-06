import { expect, test } from '@playwright/test';
import { installGraphMock } from './support/graph-mock.js';

const FILES = [
  { id: 'track-1', name: 'one.mp3' },
  { id: 'track-2', name: 'Jazz/two.mp3' },
];

// `navigator.serviceWorker.ready` can settle while the worker is 'activating'.
async function waitForServiceWorker(page) {
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.active?.state === 'activated';
  });
}

async function signInAndPickMusic(page) {
  await page.goto('/');
  await expect(page.locator('.wordmark')).toHaveText('localtune.');

  await page.locator('[data-testid="settings-open"]').click();
  await page.locator('[data-testid="source-connect-onedrive"]').click();

  await expect(page.locator('[data-testid="onedrive-picker"]')).toBeVisible();
  await expect(page.locator('[data-testid="onedrive-folder"]').first()).toHaveText('Music');
  await page.locator('[data-testid="onedrive-folder"]').first().click();
  await page.locator('[data-testid="onedrive-picker-choose"]').click();

  await expect(page.locator('[data-testid="onedrive-picker"]')).toBeHidden();
  const cloudRow = page.locator('[data-testid="source-row-onedrive"]');
  await expect(cloudRow).toContainText('2');
  await expect(cloudRow.locator('button')).toHaveCount(3);
  await expect(page.locator('[data-testid="source-connect-onedrive"]')).toBeHidden();
  await expect(page.locator('[data-testid="settings-sync-onedrive"]')).toBeVisible();
  await expect(page.locator('[data-testid="settings-source-onedrive"]')).toBeVisible();
  await expect(page.locator('[data-testid="settings-onedrive-remove"]')).toBeVisible();
  await expect(page.locator('[data-testid="settings-source-onedrive"]')).toHaveAttribute(
    'aria-label',
    '更换文件夹',
  );
  await page.locator('[data-testid="panel-open"]').click();
  await expect(page.locator('#tab-folders')).toBeVisible();
}

function elapsed(page) {
  return page.locator('#armRotor').getAttribute('aria-valuenow');
}

async function expectPlaying(page) {
  await expect(page.locator('#armRotor')).toHaveAttribute('data-playing', 'true');
  await expect.poll(() => elapsed(page), { timeout: 10_000 }).not.toBe('0');
}

test('audio cache hits, offline replay and Clear all', async ({ page, context }) => {
  test.setTimeout(180_000);

  const mock = await installGraphMock(page, { files: FILES });
  await signInAndPickMusic(page);
  await waitForServiceWorker(page);

  // Sync already pulled both files into the audio cache.
  expect(mock.wholeRequests).toHaveLength(2);

  // ---- 0. a returning user lands on the library, not the picker ----------
  await page.reload();
  await expect(page.locator('.wordmark')).toHaveText('localtune.');
  await expect(page.locator('#tab-folders')).toBeVisible();
  await expect(page.locator('[data-testid="onedrive-picker"]')).toBeHidden();
  await expect(page.locator('[data-testid="settings-open"]')).toHaveAttribute('aria-expanded', 'false');
  await page.locator('[data-testid="folder-source-onedrive"]').click();
  await expect(page.locator('[data-testid="track-row"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="folder-dir-Jazz"]')).toBeVisible();

  // ---- 1. playback after the sync downloads nothing ----------------------
  await page.locator('[data-testid="track-row"] .track').first().click();
  await expectPlaying(page);
  await page.waitForTimeout(500);
  expect(mock.wholeRequests).toHaveLength(2);

  await page.locator('[data-testid="folder-dir-Jazz"]').click();
  await page.locator('[data-testid="track-row"] .track').first().click();
  await expectPlaying(page);
  await page.waitForTimeout(500);
  expect(mock.wholeRequests).toHaveLength(2);

  await page.locator('[data-testid="folder-up"]').click();
  await page.locator('[data-testid="track-row"] .track').first().click();
  await expectPlaying(page);
  // The cached track is served from Cache Storage: no new whole request.
  await page.waitForTimeout(500);
  expect(mock.wholeRequests).toHaveLength(2);

  // ---- 2. cached playback survives an offline reload ---------------------
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.wordmark')).toHaveText('localtune.');
  await expect(page.locator('[data-testid="onedrive-picker"]')).toBeHidden();
  await expect(page.locator('[data-testid="settings-open"]')).toHaveAttribute('aria-expanded', 'false');

  await page.locator('[data-testid="folder-source-onedrive"]').click();
  await expect(page.locator('[data-testid="track-row"] .track').first()).toBeVisible();
  await page.locator('[data-testid="track-row"] .track').first().click();
  await expectPlaying(page);
  await context.setOffline(false);

  // ---- 3. Clear all empties the cache and drops the derived rows --------
  await page.locator('[data-testid="settings-open"]').click();
  const cachedMusic = page.locator('[data-testid="storage-audio"] b');
  await expect(cachedMusic).not.toHaveText('0 B');
  await expect(page.locator('[data-testid="cache-limit"]')).toBeVisible();
  await expect(page.locator('[data-testid="cache-limit-2"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  const clearAll = page.locator('[data-testid="clear-all"]');
  await expect(clearAll).toBeVisible();
  for (const gone of [
    'storage-pins',
    'storage-import',
    'clear-cache',
    'clear-library',
    'clear-import',
  ]) {
    await expect(page.locator(`[data-testid="${gone}"]`)).toHaveCount(0);
  }

  page.once('dialog', (dialog) => dialog.accept());
  await clearAll.click();

  await expect(cachedMusic).toHaveText('0 B', { timeout: 15_000 });
});
