import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { seedLocalLibrary } from './support/seed.js';

test.use({
  launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] },
});

const AUDIO = readFileSync(new URL('../tests/fixtures/silence.wav', import.meta.url)).toString(
  'base64',
);
const NAMES = ['a', 'b', 'c', 'd', 'e', 'f'];
const FILES = NAMES.map((name) => ({
  path: `Music/${name}.mp3`,
  bytesBase64: AUDIO,
  type: 'audio/wav',
}));

async function openFolderWithSixTracks(page) {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: undefined,
    });
  });
  await page.goto('/');
  await expect(page.locator('#status')).toBeHidden({ timeout: 10_000 });
  await seedLocalLibrary(page, { files: FILES });
  await page.reload();
  await page.locator('[data-testid="folder-source-local"]').click();
  await page.locator('[data-testid="folder-dir-Music"]').click();
  await expect(page.locator('[data-testid="folder-shuffle"]')).toBeVisible();
}

const queueTitles = (page) =>
  page.locator('.track-item.queue .track strong').allTextContents();

const nowTitle = (page) => page.locator('.track-item.queue.now .track strong').textContent();

test('shuffle play keeps the original set, lists playback order, and never repeats a round', async ({
  page,
}) => {
  await openFolderWithSixTracks(page);

  await page.locator('[data-testid="folder-shuffle"]').click();
  const shuffle = page.locator('[data-testid="control-shuffle"]');
  await expect(shuffle).toHaveClass(/is-on/);
  await expect(shuffle).toHaveAttribute('aria-pressed', 'true');

  await page.locator('#tab-queue').click();
  const headCount = page.locator('.list-head .queue-head span').first();
  await expect(headCount).toHaveText('6 首');

  const playOrder = await queueTitles(page);
  expect([...playOrder].sort()).toEqual(NAMES);
  expect(new Set(playOrder).size).toBe(NAMES.length);

  // Turning shuffle off restores the authoritative original order.
  await shuffle.click();
  await expect.poll(() => queueTitles(page)).toEqual(NAMES);
  await shuffle.click();
  await expect(shuffle).toHaveClass(/is-on/);

  const order = await queueTitles(page);
  expect([...order].sort()).toEqual(NAMES);
  await expect.poll(() => nowTitle(page)).toBe(order[0]);

  const seen = [order[0]];
  for (let i = 1; i < order.length; i += 1) {
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => nowTitle(page)).toBe(order[i]);
    seen.push(order[i]);
  }
  expect(new Set(seen).size).toBe(NAMES.length);
  expect([...seen].sort()).toEqual(NAMES);
});

test('repeat all opens a new round with a different first track', async ({ page }) => {
  await openFolderWithSixTracks(page);
  await page.locator('[data-testid="folder-shuffle"]').click();
  await expect(page.locator('[data-testid="control-shuffle"]')).toHaveClass(/is-on/);

  const repeat = page.locator('[data-testid="control-repeat"]');
  await repeat.click();
  await expect(repeat).toHaveAttribute('aria-pressed', 'true');

  await page.locator('#tab-queue').click();
  const order = await queueTitles(page);
  expect([...order].sort()).toEqual(NAMES);
  await expect.poll(() => nowTitle(page)).toBe(order[0]);

  const seen = [order[0]];
  for (let i = 1; i < order.length; i += 1) {
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => nowTitle(page)).toBe(order[i]);
    seen.push(order[i]);
  }
  expect([...seen].sort()).toEqual(NAMES);

  // The next track wraps into a freshly shuffled round.
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => nowTitle(page)).not.toBe(seen[seen.length - 1]);
  const first = await nowTitle(page);
  expect(NAMES).toContain(first);
  expect(first).not.toBe(seen[seen.length - 1]);
  const wrapped = await queueTitles(page);
  expect([...wrapped].sort()).toEqual(NAMES);
  expect(wrapped[0]).toBe(first);
});

test('a reload keeps the shuffle round instead of starting a new one', async ({ page }) => {
  await openFolderWithSixTracks(page);
  await page.locator('[data-testid="folder-shuffle"]').click();
  await page.locator('#tab-queue').click();

  const order = await queueTitles(page);
  const current = await nowTitle(page);
  expect([...order].sort()).toEqual(NAMES);

  await page.reload();
  await expect(page.locator('.wordmark')).toBeVisible();
  await expect(page.locator('[data-testid="control-shuffle"]')).toHaveClass(/is-on/);
  await page.locator('#tab-queue').click();

  // sessionStorage carries the round; the DB snapshot never sees `order`.
  await expect.poll(() => queueTitles(page)).toEqual(order);
  await expect.poll(() => nowTitle(page)).toBe(current);
});
