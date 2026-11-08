import { expect, test } from '@playwright/test';

test.use({
  launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] },
});

const VIEWPORT = { width: 1280, height: 900 };

async function openDemo(page) {
  await page.goto('/');
  await expect(page.locator('.track-item.queue')).toHaveCount(4);
}

async function playRow(page, index) {
  await page.locator('.track-item.queue').nth(index).locator('.track').click();
  await expect
    .poll(() => page.evaluate(() => document.querySelector('audio')?.paused), { timeout: 10_000 })
    .toBe(false);
}

async function seek(page, seconds) {
  await page.evaluate((value) => {
    document.querySelector('audio').currentTime = value;
  }, seconds);
  await page.waitForTimeout(400);
}

/**
 * Drag the platter backwards and sample the published scratch state after each
 * pointermove. The event dispatch is synchronous, so the app's data attributes
 * are already updated when the next line runs.
 */
async function scrubBack(page, { ms = 2000, stepMs = 150, deltaDeg = 10 } = {}) {
  return page.evaluate(
    async ({ ms, stepMs, deltaDeg }) => {
      const deck = document.getElementById('deck');
      const vinyl = document.querySelector('.vinyl');
      const rect = vinyl.getBoundingClientRect();
      const radius = rect.width / 2;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const fire = (type, deg) => {
        const radians = (deg * Math.PI) / 180;
        vinyl.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 31,
            pointerType: 'touch',
            isPrimary: true,
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1,
            clientX: cx + Math.cos(radians) * radius * 0.8,
            clientY: cy + Math.sin(radians) * radius * 0.8,
          }),
        );
      };
      const read = () => {
        const [engine = '', offset = '0', cached = ''] = (deck.dataset.scratch ?? '').split(',');
        return {
          t: Number(performance.now().toFixed(1)),
          engine,
          offset: Number(offset),
          cached,
          muted: Boolean(document.querySelector('audio')?.muted),
          hud: !document.querySelector('[data-testid="scrub-hud"]')?.hidden,
        };
      };

      const samples = [];
      const started = performance.now();
      fire('pointerdown', 20);
      let angle = 20;
      while (performance.now() - started < ms) {
        angle -= deltaDeg;
        fire('pointermove', angle);
        await new Promise((resolve) => setTimeout(resolve, stepMs));
        samples.push(read());
      }
      fire('pointerup', angle);
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { samples, after: read() };
    },
    { ms, stepMs, deltaDeg },
  );
}

test.describe('scratch audio', () => {
  test.use({ viewport: VIEWPORT });

  test('a cold record grab loads and starts playback inside the gesture', async ({ page }) => {
    await openDemo(page);
    const before = await page.evaluate(() => {
      const audio = document.querySelector('audio');
      return { src: audio?.currentSrc || audio?.src || '', paused: audio?.paused ?? null };
    });
    expect(before.src).toBe('');

    const cold = await page.evaluate(() => {
      const audio = document.querySelector('audio');
      const vinyl = document.querySelector('.vinyl');
      const rect = vinyl.getBoundingClientRect();
      const radius = rect.width / 2;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const radians = (20 * Math.PI) / 180;
      const started = performance.now();
      vinyl.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          pointerId: 29,
          pointerType: 'touch',
          isPrimary: true,
          button: 0,
          buttons: 1,
          clientX: cx + Math.cos(radians) * radius * 0.8,
          clientY: cy + Math.sin(radians) * radius * 0.8,
        }),
      );
      const elapsed = performance.now() - started;
      return { elapsed, src: audio?.currentSrc || audio?.src || '' };
    });

    expect(cold.src).not.toBe('');
    expect(cold.elapsed).toBeLessThanOrEqual(80);
    await expect
      .poll(() => page.evaluate(() => document.querySelector('audio')?.paused), { timeout: 2_000 })
      .toBe(false);
  });

  for (const [index, title] of [
    [0, 'Baby Girl (4:33)'],
    [1, 'JUST COMMUNICATION (30 s)'],
  ]) {
    test(`backward scrub decodes the song and never repeats the window — ${title}`, async ({
      page,
    }) => {
      await openDemo(page);
      await playRow(page, index);
      await seek(page, index === 0 ? 30 : 12);

      const { samples, after } = await scrubBack(page, { ms: 2000, stepMs: 150 });
      const engineSamples = samples.filter((sample) => sample.engine === 'e');
      expect(engineSamples.length).toBeGreaterThanOrEqual(10);

      for (let i = 1; i < engineSamples.length; i += 1) {
        expect(engineSamples[i].offset).toBeLessThan(engineSamples[i - 1].offset);
      }
      expect(engineSamples.at(-1).offset).toBeLessThan(engineSamples[0].offset);

      // The gesture is over: the window and its source are gone.
      expect(after.cached).toBe('0');
      expect(after.engine).toBe('');
    });
  }

  test('reduced motion keeps the scratch silent but still paints the HUD', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openDemo(page);
    await playRow(page, 0);
    await seek(page, 30);

    const { samples } = await scrubBack(page, { ms: 600, stepMs: 60 });
    const moved = samples.filter((sample) => sample.hud);
    expect(moved.length).toBeGreaterThan(0);
    expect(moved.every((sample) => sample.muted)).toBe(true);
    expect(moved.every((sample) => sample.engine === '')).toBe(true);
    await expect(page.getByTestId('scrub-hud')).toBeVisible();
  });
});
