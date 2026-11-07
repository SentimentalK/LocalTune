import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { installDropboxMock } from './support/dropbox-mock.js';

const wav = readFileSync(new URL('../tests/fixtures/silence.wav', import.meta.url));

async function connectAndPickMusic(page, mock, expectedMedia) {
  await page.goto('/');
  await expect(page.locator('.wordmark')).toHaveText('localtune.');

  await page.locator('[data-testid="settings-open"]').click();
  await page.locator('[data-testid="source-connect-dropbox"]').click();

  await expect(page.locator('[data-testid="dropbox-picker"]')).toBeVisible();
  await expect(page.locator('[data-testid="dropbox-folder"]').first()).toHaveText('Music');
  await page.locator('[data-testid="dropbox-folder"]').first().click();
  await expect(page.locator('[data-testid="dropbox-picker-choose"]')).toBeEnabled();
  await page.locator('[data-testid="dropbox-picker-choose"]').click();

  await expect(page.locator('[data-testid="dropbox-picker"]')).toBeHidden();
  await expect(page.locator('[data-testid="source-row-dropbox"]')).toContainText(
    String(expectedMedia),
  );
  await expect
    .poll(() => mock.mediaRequests.length, { timeout: 15_000 })
    .toBe(expectedMedia);
  // The warm pass must be over before the spec starts playing or removing:
  // its progress line keeps its last text while hidden.
  await expect(page.locator('[data-testid="source-row-dropbox"] .settings-progress')).toBeHidden();
}

async function backToFolders(page) {
  await page.locator('[data-testid="panel-open"]').click();
  await expect(page.locator('#tab-folders')).toBeVisible();
}

async function expectPlaying(page) {
  await expect(page.locator('#armRotor')).toHaveAttribute('data-playing', 'true');
  await expect
    .poll(async () => page.locator('#armRotor').getAttribute('aria-valuenow'), { timeout: 10_000 })
    .not.toBe('0');
}

test('a remote wav without tag duration is probed and keeps it after a reload', async ({ page }) => {
  test.setTimeout(120_000);
  const mock = await installDropboxMock(page, {
    files: [{ id: 'id-wav', name: 'silence.wav', path: '/Music/silence.wav' }],
    audio: wav,
  });

  await connectAndPickMusic(page, mock, 1);
  await backToFolders(page);
  await page.locator('[data-testid="folder-source-dropbox"]').click();

  const rows = page.locator('[data-testid="track-row"]');
  const duration = page.locator('[data-testid="track-row"] .track-dur').first();
  await expect(rows).toHaveCount(1);
  await expect(duration).toHaveText('0:02');

  await page.locator('[data-testid="track-row"] .track').first().click();
  await expectPlaying(page);
  await expect(duration).toHaveText('0:02');

  await page.reload();
  await expect(page.locator('.wordmark')).toHaveText('localtune.');
  await expect(page.locator('#tab-folders')).toBeVisible();
  await page.locator('[data-testid="folder-source-dropbox"]').click();
  await expect(rows).toHaveCount(1);
  await expect(page.locator('[data-testid="track-row"] .track-dur').first()).toHaveText('0:02');
});

test('an undecodable remote file shows an unknown duration', async ({ page }) => {
  test.setTimeout(120_000);
  const mock = await installDropboxMock(page, {
    files: [{ id: 'id-bad', name: 'broken.wav', path: '/Music/broken.wav' }],
    audio: Buffer.from('this is not audio'),
  });

  await connectAndPickMusic(page, mock, 1);
  await expect(page.locator('[data-testid="source-row-dropbox"]')).toContainText('1');

  await backToFolders(page);
  await page.locator('[data-testid="folder-source-dropbox"]').click();
  await expect(page.locator('[data-testid="track-row"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="track-row"] .track-dur').first()).toHaveText('--:--');
});
