import { expect, test } from '@playwright/test';
import { openSeededLibrary } from './support/seed.js';

// The tonearm is the transport: tap toggles playback, arrow keys seek. There is
// no second control row on any viewport.

async function openPlaying(page) {
  await openSeededLibrary(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.locator('#armRotor')).toHaveAttribute('data-playing', 'true');
}

test.describe('tonearm transport at 390x844', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('tap pauses and resumes, arrows seek', async ({ page }) => {
    await openPlaying(page);
    const arm = page.locator('#armRotor');

    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press('Space');
    await expect(arm).toHaveAttribute('data-playing', 'false');
    await page.keyboard.press('Space');
    await expect(arm).toHaveAttribute('data-playing', 'true');

    await arm.evaluate((node) => node.focus());
    await page.keyboard.press('Enter');
    await expect(arm).toHaveAttribute('data-playing', 'false');
    await expect(arm).toHaveAttribute('aria-valuetext', /0:0\d \/ 1:00/);

    await arm.evaluate((node) => node.focus());
    await page.keyboard.press('ArrowRight');
    await expect
      .poll(async () => Number(await arm.getAttribute('aria-valuenow')), { timeout: 3_000 })
      .toBeGreaterThan(0);
    const seeked = Number(await arm.getAttribute('aria-valuenow'));
    expect(seeked).toBeGreaterThan(0);

    // Parked arm is a stable tap target: tap resumes from the new position.
    await page.locator('.arm-head-hit').click();
    await expect(arm).toHaveAttribute('data-playing', 'true');

    await page.screenshot({ path: 'test-results/transport-390.png' });
  });

  test('dragging the arm seeks and starts playback, swiping changes tracks', async ({ page }) => {
    await openPlaying(page);
    const arm = page.locator('#armRotor');

    // Park the arm first so its head has a stable hit box.
    await arm.evaluate((node) => node.focus());
    await page.keyboard.press('Enter');
    await expect(arm).toHaveAttribute('data-playing', 'false');

    const head = await page.locator('.arm-head-hit').boundingBox();
    expect(head).not.toBeNull();
    const startX = head.x + head.width / 2;
    const startY = head.y + head.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 26, startY + 26, { steps: 12 });
    await page.mouse.up();

    // Dropping the arm onto the record starts playback, even when the drag
    // began paused (real deck semantics).
    await expect(arm).toHaveAttribute('data-playing', 'true');
    await expect
      .poll(async () => Number(await arm.getAttribute('aria-valuenow')), { timeout: 5_000 })
      .toBeGreaterThan(0);

    // Horizontal swipe on the stage: left = next track.
    const before = await page.locator('.song').textContent();
    await page.evaluate(() => {
      const stage = document.querySelector('.stage');
      const fire = (type, x, y) =>
        stage.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerId: 7,
            pointerType: 'touch',
            clientX: x,
            clientY: y,
          }),
        );
      fire('pointerdown', 260, 300);
      fire('pointermove', 160, 302);
      fire('pointerup', 160, 302);
    });
    await expect
      .poll(async () => page.locator('.song').textContent(), { timeout: 5_000 })
      .not.toBe(before);
  });
});

test.describe('tonearm transport at 360x780', () => {
  test.use({ viewport: { width: 360, height: 780 } });

  test('stage, modes and inline library fit without horizontal overflow', async ({ page }) => {
    await openPlaying(page);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    await expect(page.locator('.controls')).toHaveCount(0);
    await expect(page.locator('.progress')).toHaveCount(0);
    await expect(page.locator('#tab-folders')).toBeVisible();

    await page.screenshot({ path: 'test-results/transport-360.png' });
  });
});
