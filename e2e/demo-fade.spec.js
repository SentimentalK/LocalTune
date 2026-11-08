import { expect, test } from '@playwright/test';

test.use({
  launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] },
});

const readAudio = (page) =>
  page.evaluate(() => {
    const audio = document.querySelector('audio');
    return {
      src: audio?.currentSrc ?? '',
      duration: audio?.duration ?? 0,
      volume: audio?.volume ?? null,
    };
  });

test('demo queue leads with Baby Girl and a 30 s demo fades into the next track', async ({
  page,
}) => {
  test.setTimeout(45_000);
  await page.goto('/');

  const rows = page.locator('.track-item.queue');
  await expect(rows).toHaveCount(4);
  expect(await rows.locator('.track strong').allTextContents()).toEqual([
    'Baby Girl',
    'JUST COMMUNICATION',
    'ハチミツ',
    '自由的你',
  ]);
  await expect(page.locator('.track-item.queue.now .track strong')).toHaveText('Baby Girl');

  // Every demo row paints its extracted cover.
  await expect
    .poll(() =>
      rows
        .locator('img.track-cover')
        .evaluateAll((images) => images.filter((img) => img.complete && img.naturalWidth > 0).length),
    )
    .toBe(4);
  // Rows use the content-addressed 96 px thumbnails, not the stage covers.
  const coverPaths = await rows
    .locator('img.track-cover')
    .evaluateAll((images) => images.map((img) => new URL(img.src).pathname));
  expect(coverPaths).toHaveLength(4);
  for (const [index, slug] of ['baby-girl', 'just-communication', 'hachimitsu', 'ziyou-de-ni'].entries()) {
    expect(coverPaths[index]).toMatch(new RegExp(`^/demo/${slug}\\.[0-9a-f]{8}-96\\.webp$`));
  }

  // Play the 30 s trim fast (the dev server sends no ranges, so a forward seek
  // would be clamped to 0). Sample from inside the page: the fade window is
  // shorter than an outside poll interval at 4x.
  await rows.nth(1).locator('.track').click();
  await expect.poll(async () => (await readAudio(page)).src).toContain('just-communication.mp3');
  await expect.poll(async () => (await readAudio(page)).duration).toBeGreaterThan(29);

  await page.evaluate(() => {
    const audio = document.querySelector('audio');
    window.__fadeSamples = [];
    audio.addEventListener('timeupdate', () => {
      if (!audio.currentSrc.includes('just-communication.mp3')) return;
      window.__fadeSamples.push({
        position: audio.currentTime,
        duration: audio.duration,
        volume: audio.volume,
      });
    });
    audio.playbackRate = 4;
  });
  await expect
    .poll(
      () => page.evaluate(() => Math.min(...window.__fadeSamples.map((s) => s.volume), 1)),
      { timeout: 15_000 },
    )
    .toBeLessThan(0.95);

  // The next demo starts at full volume once this one ends.
  await expect
    .poll(async () => (await readAudio(page)).src, { timeout: 10_000 })
    .toContain('hachimitsu.mp3');
  await expect.poll(async () => (await readAudio(page)).volume, { timeout: 5_000 }).toBe(1);
});
