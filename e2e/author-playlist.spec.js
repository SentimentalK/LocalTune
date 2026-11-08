import { expect, test } from '@playwright/test';

const isAuthorAudio = (url) => url.includes('/author/') && url.endsWith('.mp3');
const isPlaylistChunk = (url) => /\/assets\/playlist-[^/]+\.js$/.test(url);

function trackRequests(page) {
  const audio = [];
  const chunks = [];
  page.on('request', (request) => {
    const url = request.url();
    if (isAuthorAudio(url)) audio.push(url);
    if (isPlaylistChunk(url)) chunks.push(url);
  });
  return { audio, chunks };
}

test('demo-only visitors never load the author playlist', async ({ page }) => {
  const requests = trackRequests(page);
  await page.goto('/');
  // Give the service worker time to install and run its precache pass.
  await page.waitForTimeout(1200);

  expect(requests.chunks).toEqual([]);
  expect(requests.audio).toEqual([]);
  // The demo queue is what a first-time visitor gets.
  await expect(page.locator('#tab-queue')).toHaveAttribute('aria-selected', 'true');
});

test('the featured list plays all or shuffles like a folder', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tab-author').click();
  await expect(page.locator('#trackList [data-testid="track-row"]')).toHaveCount(6);
  await expect(page.locator('#trackList [data-testid="track-row"] strong').first()).toHaveText(
    '情非得已',
  );
  await expect(page.locator('.folder-head .folder-name')).toHaveText('曲目');
  await expect(page.locator('.author-count')).toHaveCount(0);
  await expect(page.locator('.author-note')).toBeVisible();
  await expect(page.locator('[data-testid="author-play-all"]')).toBeVisible();
  await expect(page.locator('[data-testid="author-shuffle"]')).toBeVisible();

  await page.locator('[data-testid="author-shuffle"]').click();
  await page.locator('#tab-queue').click();
  await expect(page.locator('.track-item.queue')).toHaveCount(6);
});

test('the author tab loads metadata on open and audio only after play', async ({ page }) => {
  const requests = trackRequests(page);
  await page.goto('/');

  // The empty library offers the author playlist next to Settings.
  await page.locator('#tab-folders').click();
  await expect(page.locator('[data-testid="empty-author"]')).toBeVisible();
  // Settings and the featured CTA share one row.
  const buttonRow = await page.evaluate(() => {
    const primary = document.querySelector('.empty-actions .btn-pill');
    const featured = document.querySelector('[data-testid="empty-author"]');
    return Math.abs(primary.getBoundingClientRect().top - featured.getBoundingClientRect().top);
  });
  expect(buttonRow).toBeLessThan(2);
  expect(requests.chunks).toEqual([]);
  expect(requests.audio).toEqual([]);

  await page.locator('[data-testid="empty-author"]').click();
  await expect(page.locator('#tab-author')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#trackList [data-testid="track-row"]')).toHaveCount(6);
  expect(requests.chunks.length).toBeGreaterThan(0);
  expect(requests.audio).toEqual([]);
  // Every row has artwork and the source footer points at the channel.
  await expect(page.locator('#trackList .track-cover[src]')).toHaveCount(6);
  await expect(page.locator('[data-testid="author-source"]')).toHaveAttribute(
    'href',
    'https://www.youtube.com/@feixinglianhua',
  );

  // One play starts the track and warms the rest of the playlist.
  await page.locator('#trackList [data-testid="track-row"]').first().click();
  await expect.poll(() => requests.audio.length, { timeout: 30_000 }).toBe(6);

  // Every file is in the shared audio cache, so the next play is offline.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const cache = await caches.open('audio-v1');
          return (await cache.keys()).length;
        }),
      { timeout: 30_000 },
    )
    .toBe(6);

  await page.locator('#trackList [data-testid="track-row"]').nth(1).click();
  await page.waitForTimeout(1200);
  expect(requests.audio.length).toBe(6);
});
