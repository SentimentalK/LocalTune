import { expect, test } from '@playwright/test';

// CPU pressure on the deck: the arm used to write a transform every frame, and
// playback had no fallback when the main thread kept stalling. These specs hold
// the per-frame write budget and the low-power enter/exit path.
test.use({
  launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] },
});

async function startPlayback(page) {
  await page.goto('/');
  await expect(page.locator('.deck')).toBeVisible();
  await page.locator('.arm-head-hit').click();
  await expect(page.locator('#armRotor')).toHaveAttribute('data-playing', 'true');
  await page.waitForFunction(() => (document.querySelector('audio')?.readyState ?? 0) >= 3);
}

test('playing writes the tonearm transform at most 35 times a second', async ({ page }) => {
  await startPlayback(page);
  await page.evaluate(() => {
    window.__armWrites = 0;
    const rotor = document.querySelector('#armRotor');
    window.__armObserver = new MutationObserver((records) => {
      for (const record of records) {
        if (record.attributeName === 'style') window.__armWrites += 1;
      }
    });
    window.__armObserver.observe(rotor, { attributes: true, attributeFilter: ['style'] });
  });

  await page.waitForTimeout(1_000);
  const writes = await page.evaluate(() => {
    window.__armObserver.disconnect();
    return window.__armWrites;
  });
  expect(writes).toBeLessThanOrEqual(35);
});

test('two long tasks enter low power and the class leaves after the window drains', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await startPlayback(page);

  // A busy loop inside a direct evaluate runs as a CDP task the page's
  // PerformanceObserver never sees; schedule the burn as a page timer instead.
  for (let i = 0; i < 2; i += 1) {
    await page.evaluate(() => {
      setTimeout(() => {
        const start = performance.now();
        while (performance.now() - start < 150);
      }, 0);
    });
    await page.waitForTimeout(400);
  }

  await expect(page.locator('html')).toHaveClass(/is-low-power/, { timeout: 5_000 });
  await expect(page.locator('#armRotor')).toHaveAttribute('data-playing', 'true');
  await expect(page.locator('html')).not.toHaveClass(/is-low-power/, { timeout: 45_000 });
  await expect(page.locator('#armRotor')).toHaveAttribute('data-playing', 'true');
});

test('an audio stall alone enters low power', async ({ page }) => {
  await startPlayback(page);
  await page.evaluate(() => {
    document.querySelector('audio').dispatchEvent(new Event('waiting'));
  });
  await expect(page.locator('html')).toHaveClass(/is-low-power/, { timeout: 5_000 });
});

test('low power keeps the disc spinning at half speed', async ({ page }) => {
  await startPlayback(page);
  await page.evaluate(() => document.documentElement.classList.add('is-low-power'));
  await expect(page.locator('html')).toHaveClass(/is-low-power/);
  await expect(page.locator('.deck')).toHaveClass(/is-playing/);

  const style = await page.evaluate(() => {
    const cover = getComputedStyle(document.querySelector('#cover'));
    return {
      animationName: cover.animationName,
      animationDuration: cover.animationDuration,
      animationPlayState: cover.animationPlayState,
    };
  });
  expect(style.animationName).toBe('spin');
  expect(Number.parseFloat(style.animationDuration)).toBeCloseTo(26, 1);
  expect(style.animationPlayState).toBe('running');
});

test('a paused cover is forced back to running while playing', async ({ page }) => {
  const warnings = [];
  page.on('console', (message) => {
    if (message.type() === 'warning') warnings.push(message.text());
  });
  await startPlayback(page);
  await page.addStyleTag({ content: '#cover { animation-play-state: paused !important; }' });

  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.querySelector('#cover')).animationPlayState))
    .toBe('running');
  expect(warnings.some((text) => text.includes('disc spin was paused while playing'))).toBe(true);

  await page.locator('.arm-head-hit').click();
  await expect(page.locator('.deck')).not.toHaveClass(/is-playing/);
  const paused = await page.evaluate(() => ({
    inline: document.querySelector('#cover').style.getPropertyValue('animation-play-state'),
    computed: getComputedStyle(document.querySelector('#cover')).animationPlayState,
  }));
  expect(paused.inline).toBe('');
  expect(paused.computed).toBe('paused');
});

test('a hidden document stops the arm frame loop until it is visible again', async ({ page }) => {
  await page.addInitScript(() => {
    window.__raf = 0;
    const native = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => {
      window.__raf += 1;
      return native(callback);
    };
  });
  await startPlayback(page);
  await page.waitForTimeout(200);

  const hiddenAt = await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    return window.__raf;
  });
  await page.waitForTimeout(500);
  const whileHidden = await page.evaluate(() => window.__raf);
  expect(whileHidden - hiddenAt).toBeLessThanOrEqual(1);

  const visibleAt = await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
    return window.__raf;
  });
  await page.waitForTimeout(500);
  const whileVisible = await page.evaluate(() => window.__raf);
  expect(whileVisible).toBeGreaterThan(visibleAt);
});
