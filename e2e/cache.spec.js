import { expect, test } from '@playwright/test';
import { installGraphMock } from './support/graph-mock.js';

const FILES = [
  { id: 'track-1', name: 'one.mp3' },
  { id: 'track-2', name: 'two.mp3' },
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
  await expect(page.locator('#app h1')).toHaveText('LocalTune');

  await page.locator('[data-testid="settings-open"]').click();
  await page.locator('[data-testid="settings-source-add"]').click();
  await page.locator('[data-testid="settings-source-onedrive"]').click();

  await expect(page.locator('[data-testid="onedrive-picker"]')).toBeVisible();
  await expect(page.locator('[data-testid="onedrive-folder"]').first()).toHaveText('Music');
  await page.locator('[data-testid="onedrive-folder"]').first().click();
  await page.locator('[data-testid="onedrive-picker-choose"]').click();

  await expect(page.locator('[data-testid="onedrive-picker"]')).toBeHidden();
  await expect(page.locator('[data-testid="source-row-onedrive"]')).toContainText('2');
  await page.locator('[data-testid="settings-back"]').click();
  await expect(page.locator('#tab-tracks')).toBeVisible();
}

function elapsed(page) {
  return page.locator('.progress time').first().textContent();
}

async function expectPlaying(page) {
  await expect(page.locator('.controls .btn.main')).toHaveAttribute('aria-label', '暂停');
  await expect.poll(() => elapsed(page), { timeout: 10_000 }).not.toBe('0:00');
}

test('audio cache hits, offline replay, folder pins and clearing', async ({ page, context }) => {
  test.setTimeout(180_000);

  const mock = await installGraphMock(page, { files: FILES });
  await signInAndPickMusic(page);
  await waitForServiceWorker(page);

  // ---- 1. one whole download per track, none on replay -------------------
  await page.locator('.row-hit').first().click();
  await expect.poll(() => mock.wholeRequests.length, { timeout: 10_000 }).toBe(1);
  await expectPlaying(page);

  await page.locator('.row-hit').nth(1).click();
  await expect.poll(() => mock.wholeRequests.length, { timeout: 10_000 }).toBe(2);

  await page.locator('.row-hit').first().click();
  await expectPlaying(page);
  // The cached track is served from Cache Storage: no new whole request.
  await page.waitForTimeout(500);
  expect(mock.wholeRequests).toHaveLength(2);

  // ---- 2. cached playback survives an offline reload ---------------------
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#app h1')).toHaveText('LocalTune');
  await expect(page.locator('[data-testid="settings-back"]')).toBeVisible();
  await page.locator('[data-testid="settings-back"]').click();

  await expect(page.locator('.row-hit').first()).toBeVisible();
  await page.locator('.row-hit').first().click();
  await expectPlaying(page);
  await context.setOffline(false);

  // ---- 3. pin the folder for offline use --------------------------------
  await page.locator('#tab-folders').click();
  const pinButton = page.locator('[data-testid="pin-root"]');
  await expect(pinButton).toBeVisible();
  await expect(pinButton).toHaveAttribute('aria-pressed', 'false');

  await pinButton.click();
  await expect(pinButton).toHaveAttribute('aria-pressed', 'true');
  await expect(pinButton).toBeEnabled({ timeout: 20_000 });
  const folderRow = page.locator('.rows .row').first();
  await expect(folderRow).toContainText('已固定离线');
  // Both tracks are cached; the pin fetched from the cache, not the network.
  expect(mock.wholeRequests).toHaveLength(2);

  // ---- 4. clearing the cache also clears the pins -----------------------
  await page.locator('[data-testid="settings-open"]').click();
  const cachedMusic = page.locator('[data-testid="storage-audio"] b');
  const pinnedCount = page.locator('[data-testid="storage-pins"]');
  await expect(cachedMusic).not.toHaveText('0 B');
  await expect(pinnedCount).toContainText('已固定 1 项');

  await expect(page.locator('[data-testid="cache-limit"]')).toBeVisible();
  await expect(page.locator('[data-testid="cache-limit-2"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('[data-testid="clear-cache"]').click();

  await expect(cachedMusic).toHaveText('0 B', { timeout: 10_000 });
  await expect(pinnedCount).toContainText('已固定 0 项');
});
