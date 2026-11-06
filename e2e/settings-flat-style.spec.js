import { expect, test } from '@playwright/test';
import { installGraphMock } from './support/graph-mock.js';

const FILES = [
  { id: 'track-1', name: 'one.mp3' },
  { id: 'track-2', name: 'two.mp3' },
];

async function openSettings(page) {
  await page.goto('/');
  await expect(page.locator('.wordmark')).toHaveText('localtune.');
  await page.locator('[data-testid="settings-open"]').click();
  await expect(page.locator('[data-testid="source-row-local"]')).toBeVisible();
}

test('disconnected sources show a title and a hint, never a zero count', async ({ page }) => {
  await openSettings(page);

  await expect(page.locator('.settings-view .source-title')).toHaveText([
    '本地文件夹',
    'OneDrive',
    'Google Drive',
    'Dropbox',
  ]);
  await expect(page.locator('.settings-view .source-subtitle')).toHaveText([
    '选择这台设备上的音乐目录',
    '连接 OneDrive 音乐目录',
    '连接 Google Drive 音乐目录',
    '连接 Dropbox 音乐目录',
  ]);

  const counts = page.locator('.settings-view .source-count');
  await expect(counts).toHaveCount(4);
  for (let index = 0; index < 4; index += 1) {
    await expect(counts.nth(index)).toBeHidden();
  }

  const text = await page.locator('.settings-view').innerText();
  expect(text).not.toContain('0 首');
  expect(text).not.toContain('0 tracks');
});

test('a connected source shows its folder name and its track count', async ({ page }) => {
  await installGraphMock(page, { files: FILES });
  await openSettings(page);

  await page.locator('[data-testid="source-connect-onedrive"]').click();
  await expect(page.locator('[data-testid="onedrive-picker"]')).toBeVisible();
  await page.locator('[data-testid="onedrive-folder"]').first().click();
  await page.locator('[data-testid="onedrive-picker-choose"]').click();
  await expect(page.locator('[data-testid="onedrive-picker"]')).toBeHidden();

  const row = page.locator('[data-testid="source-row-onedrive"]');
  await expect(row.locator('.source-subtitle')).toHaveText('Music');
  await expect(row.locator('.source-count')).toBeVisible();
  await expect(row.locator('.source-count')).toContainText('2 首');
});

test('the background playback heading is stated once', async ({ page }) => {
  await openSettings(page);

  const counts = await page.evaluate(() => {
    const section = document.querySelector('[data-testid="settings-section-background"]');
    const block = section?.closest('.settings-block');
    // Count standalone title lines: the body copy also starts with the phrase,
    // but only the heading occupies a line of its own.
    const titleLines = (node) =>
      (node?.innerText.split('\n') ?? []).filter((line) => line.trim() === '后台播放').length;
    return {
      block: titleLines(block),
      view: titleLines(document.querySelector('.settings-view')),
      removed: document.querySelectorAll('.settings-view .background-title').length,
    };
  });

  // The heading is the block's h3 sibling of the section, so the block is the
  // narrowest element that holds both the heading and the section body.
  expect(counts.block).toBe(1);
  expect(counts.view).toBe(1);
  expect(counts.removed).toBe(0);
});
