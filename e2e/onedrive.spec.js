import { expect, test } from '@playwright/test';
import { installGraphMock } from './support/graph-mock.js';

const FILES = [
  { id: 'track-1', name: 'one.mp3' },
  { id: 'track-2', name: 'two.mp3' },
];

test('OneDrive sync caches the files and playback downloads nothing', async ({ page }) => {
  const mock = await installGraphMock(page, { files: FILES });

  await page.goto('/');
  await expect(page.locator('#app h1')).toHaveText('LocalTune');

  await page.locator('[data-testid="settings-open"]').click();
  await page.locator('[data-testid="settings-source-onedrive"]').click();

  // The login navigation is mocked with a 302 back to the app; init reopens
  // settings and the folder picker automatically.
  await expect(page.locator('[data-testid="onedrive-picker"]')).toBeVisible();
  await expect(page.locator('[data-testid="onedrive-folder"]').first()).toHaveText('Music');
  await page.locator('[data-testid="onedrive-folder"]').first().click();

  await expect(page.locator('[data-testid="onedrive-picker-up"]')).toBeEnabled();
  await page.locator('[data-testid="onedrive-picker-choose"]').click();

  await expect(page.locator('[data-testid="onedrive-picker"]')).toBeHidden();
  await expect(page.locator('[data-testid="source-row-onedrive"]')).toContainText('2');

  // Sync pulls both files into the audio cache; the picker closes only after
  // the warm pass finished.
  expect(mock.wholeRequests).toHaveLength(2);

  await page.locator('[data-testid="settings-close"]').click();
  await expect(page.locator('#tab-folders')).toBeVisible();

  // The row names the source, not the folder the user picked inside it.
  const sourceRow = page.locator('[data-testid="folder-source-onedrive"]');
  await expect(sourceRow.locator('b')).toHaveText('OneDrive');
  await expect(sourceRow).not.toContainText('Music');

  await page.locator('[data-testid="folder-source-onedrive"]').click();
  await page.locator('[data-testid="track-row"] .row-hit').first().click();
  const playButton = page.locator('.controls .btn.main');
  await expect(playButton).toHaveAttribute('aria-label', '暂停');
  await expect
    .poll(async () => page.locator('.progress time').first().textContent(), { timeout: 10_000 })
    .not.toBe('0:00');

  // Playback reads Cache Storage: no extra whole-file download.
  await page.waitForTimeout(300);
  expect(mock.wholeRequests).toHaveLength(2);
});

test('the OneDrive button starts the Microsoft login when signed out', async ({ page }) => {
  await installGraphMock(page, { files: FILES });

  await page.goto('/');
  await page.locator('[data-testid="settings-open"]').click();

  const login = page.waitForRequest((request) =>
    request.url().startsWith('https://login.microsoftonline.com/'),
  );
  await page.locator('[data-testid="settings-source-onedrive"]').click();

  const request = await login;
  expect(request.url()).toContain('/authorize');
});
