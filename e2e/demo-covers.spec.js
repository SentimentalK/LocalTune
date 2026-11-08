import { expect, test } from '@playwright/test';

// APP-001-BN: the first frame must paint the stage cover, the stage uses the
// 640 px WebP, and list rows use the tiny 96 px thumbnail.

const STAGE = /^\/demo\/baby-girl\.[0-9a-f]{8}\.webp$/;
const THUMB = /^\/demo\/baby-girl\.[0-9a-f]{8}-96\.webp$/;

test('stage paints the 640 px cover and rows use 96 px thumbnails', async ({ page }) => {
  await page.goto('/');

  const stage = page.locator('#cover');
  // First frame: the stage image decodes before we assert anything else.
  await expect
    .poll(() => stage.evaluate((img) => (img.complete ? img.naturalWidth : 0)))
    .toBeGreaterThan(0);

  expect(await stage.evaluate((img) => new URL(img.src).pathname)).toMatch(STAGE);
  expect(
    await stage.evaluate((img) => ({
      fetchpriority: img.getAttribute('fetchpriority'),
      decoding: img.getAttribute('decoding'),
      width: img.getAttribute('width'),
      height: img.getAttribute('height'),
    })),
  ).toEqual({ fetchpriority: 'high', decoding: 'async', width: '640', height: '640' });

  // 640 on the long edge: the 96 px thumbnail would fail this.
  const stageWidth = await stage.evaluate((img) => Math.max(img.naturalWidth, img.naturalHeight));
  expect(stageWidth).toBe(640);

  const rows = page.locator('.track-item.queue img.track-cover');
  await expect
    .poll(() => rows.evaluateAll((imgs) => imgs.filter((img) => img.complete && img.naturalWidth > 0).length))
    .toBe(4);

  const thumbs = await rows.evaluateAll((imgs) =>
    imgs.map((img) => ({
      path: new URL(img.src).pathname,
      loading: img.loading,
      width: img.naturalWidth,
    })),
  );
  expect(thumbs.map((thumb) => thumb.width)).toEqual([96, 96, 96, 96]);
  expect(thumbs.every((thumb) => thumb.loading === 'lazy')).toBe(true);
  expect(thumbs[0].path).toMatch(THUMB);

  // Transfer size of the stage cover: a real network fetch of the 640 px file,
  // not the ~3 KB thumbnail and not a zero-size cached response.
  const entry = await page.evaluate(() => {
    const pathname = new URL(document.querySelector('#cover').src).pathname;
    const hit = performance
      .getEntriesByType('resource')
      .find((item) => new URL(item.name).pathname === pathname);
    return hit ? { transferSize: hit.transferSize, decodedBodySize: hit.decodedBodySize } : null;
  });
  expect(entry).not.toBeNull();
  expect(entry.transferSize).toBeGreaterThan(40_000);
  expect(entry.decodedBodySize).toBeGreaterThan(40_000);
});
