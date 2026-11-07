import { expect, test } from '@playwright/test';

test.use({
  launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] },
});

// The demo library is the fixture: four queue rows, Baby Girl first.
async function openDemo(page) {
  await page.goto('/');
  const rows = page.locator('.track-item.queue');
  await expect(rows).toHaveCount(4);
  await rows.first().locator('.track').click();
  await expect(page.locator('.song')).toHaveText('Baby Girl');
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.locator('#deck')).not.toHaveClass(/swapping/);
}

// Count swap animations: one per transition into the `swapping` class. Reading
// each record's resulting class keeps a remove+add pair inside one callback
// from counting twice.
async function watchSwaps(page) {
  await page.evaluate(() => {
    const deck = document.getElementById('deck');
    const hasSwapping = (value) => String(value ?? '').split(/\s+/).includes('swapping');
    window.__deckSwaps = 0;
    let previous = deck.classList.contains('swapping');
    new MutationObserver((records) => {
      for (let i = 0; i < records.length; i += 1) {
        const next = records[i + 1]
          ? hasSwapping(records[i + 1].oldValue)
          : hasSwapping(deck.getAttribute('class'));
        if (next && !previous) window.__deckSwaps += 1;
        previous = next;
      }
    }).observe(deck, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
  });
}

// Touch swipe on the stage: negative dx = next, positive dx = previous.
async function swipe(page, dx) {
  await page.evaluate((distance) => {
    const stage = document.querySelector('.stage');
    const box = stage.getBoundingClientRect();
    const startX = box.left + box.width / 2;
    const startY = box.top + box.height * 0.75;
    const fire = (type, x) =>
      stage.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerId: 11,
          pointerType: 'touch',
          clientX: x,
          clientY: startY,
        }),
      );
    fire('pointerdown', startX);
    fire('pointermove', startX + distance / 2);
    fire('pointermove', startX + distance);
    fire('pointerup', startX + distance);
  }, dx);
}

test('arrow keys change tracks with the swap animation', async ({ page }) => {
  await openDemo(page);
  await watchSwaps(page);
  const scrollY = await page.evaluate(() => window.scrollY);

  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.song')).toHaveText('JUST COMMUNICATION');
  await expect.poll(() => page.evaluate(() => window.__deckSwaps)).toBeGreaterThan(0);

  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.song')).toHaveText('Baby Girl');
  await expect.poll(() => page.evaluate(() => window.__deckSwaps)).toBeGreaterThan(1);

  // Arrows no longer scroll the page.
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);

  // Holding the key does not skip tracks.
  await page.evaluate(() =>
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        code: 'ArrowRight',
        repeat: true,
        bubbles: true,
      }),
    ),
  );
  await page.waitForTimeout(400);
  await expect(page.locator('.song')).toHaveText('Baby Girl');

  // A focused text field keeps its arrows.
  await page.locator('[data-testid="search-input"]').click();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(400);
  await expect(page.locator('.song')).toHaveText('Baby Girl');

  // An open modal keeps its arrows.
  await page.locator('[data-testid="settings-open"]').click();
  await page.locator('[data-testid="settings-section-about"] [data-testid="playlog-open"]').click();
  await expect(page.locator('[data-testid="playlog-panel"]')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(400);
  await expect(page.locator('.song')).toHaveText('Baby Girl');

  // Only the two real track changes animated.
  expect(await page.evaluate(() => window.__deckSwaps)).toBe(2);

  // The vinyl cover is not a native drag source.
  const cover = page.locator('#cover');
  await expect(cover).toHaveAttribute('draggable', 'false');
  expect(
    await cover.evaluate((node) =>
      getComputedStyle(node).getPropertyValue('-webkit-user-drag').trim(),
    ),
  ).toBe('none');
});

test.describe('touch', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('touch swipes change tracks with the swap animation', async ({ page }) => {
    await openDemo(page);
    await watchSwaps(page);

    await swipe(page, -120);
    await expect(page.locator('.song')).toHaveText('JUST COMMUNICATION');
    await expect.poll(() => page.evaluate(() => window.__deckSwaps)).toBeGreaterThan(0);

    await swipe(page, 120);
    await expect(page.locator('.song')).toHaveText('Baby Girl');
    await expect.poll(() => page.evaluate(() => window.__deckSwaps)).toBeGreaterThan(1);
  });
});

test('mouse drag on the stage changes tracks with the swap animation', async ({ page }) => {
  await openDemo(page);
  await watchSwaps(page);

  const box = await page.locator('#deck').boundingBox();
  expect(box).not.toBeNull();
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;

  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX - 120, centerY, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator('.song')).toHaveText('JUST COMMUNICATION');
  await expect.poll(() => page.evaluate(() => window.__deckSwaps)).toBeGreaterThan(0);

  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + 120, centerY, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator('.song')).toHaveText('Baby Girl');
  await expect.poll(() => page.evaluate(() => window.__deckSwaps)).toBeGreaterThan(1);
});
