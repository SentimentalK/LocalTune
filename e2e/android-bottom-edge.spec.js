import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Pixel 9a: 412x915 CSS px. Android gesture navigation reports a 24 or 48 px
// bottom safe-area inset; CDP drives env(safe-area-inset-*) directly.
const VIEWPORT = { width: 412, height: 915 };
const THEMES = {
  blue: { hex: '#101921', rgb: 'rgb(16, 25, 33)' },
  burgundy: { hex: '#211519', rgb: 'rgb(33, 21, 25)' },
  forest: { hex: '#111e1b', rgb: 'rgb(17, 30, 27)' },
  obsidian: { hex: '#0a0a0b', rgb: 'rgb(10, 10, 11)' },
  aubergine: { hex: '#100e14', rgb: 'rgb(16, 14, 20)' },
};
const INSETS = [24, 48];
const SHOT_DIR = process.env.AD_SHOT_DIR ?? '';

// One scanline of pure near-white means a real white strip (the installed-app
// bug shows the browser window colour there). Highlights and antialiasing stay
// far below this share.
const MAX_WHITE_ROW = 0.02;
const MAX_BG_DISTANCE = 12;

async function setSafeArea(context, page, bottom) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', {
    insets: { top: 0, left: 0, bottom, right: 0 },
  });
  return cdp;
}

async function loadTheme(page, theme) {
  await page.goto('/');
  await page.evaluate((value) => localStorage.setItem('localtune-theme', value), theme);
  await page.reload({ waitUntil: 'load' });
}

/** Modal colour and worst near-white scanline share of the bottom band. */
async function bandStats(page, inset) {
  const shot = await page.screenshot({
    clip: { x: 0, y: VIEWPORT.height - inset, width: VIEWPORT.width, height: inset },
  });
  if (SHOT_DIR) {
    await mkdir(SHOT_DIR, { recursive: true });
    await writeFile(path.join(SHOT_DIR, `bottom-${inset}-${test.info().title.replaceAll(/[^a-z0-9]+/gi, '-')}.png`), shot);
  }
  const base64 = shot.toString('base64');
  return page.evaluate(async (payload) => {
    const bytes = Uint8Array.from(atob(payload), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const counts = new Map();
    let whiteRow = 0;
    for (let y = 0; y < height; y += 1) {
      let white = 0;
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        const key = `${data[index]},${data[index + 1]},${data[index + 2]}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (data[index] > 230 && data[index + 1] > 230 && data[index + 2] > 230) white += 1;
      }
      whiteRow = Math.max(whiteRow, white / width);
    }
    let modal = [0, 0, 0];
    let best = 0;
    for (const [key, count] of counts) {
      if (count > best) {
        best = count;
        modal = key.split(',').map(Number);
      }
    }
    return { modal, whiteRow };
  }, base64);
}

test.describe('installed-app bottom edge', () => {
  test.use({ viewport: VIEWPORT, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  for (const [theme, expected] of Object.entries(THEMES)) {
    for (const inset of INSETS) {
      test(`${theme} paints the ${inset}px safe area`, async ({ context, page }) => {
        await loadTheme(page, theme);
        await setSafeArea(context, page, inset);
        await page.waitForTimeout(150);

        const state = await page.evaluate(() => {
          const root = getComputedStyle(document.documentElement);
          const band = getComputedStyle(document.body, '::after');
          const app = document.querySelector('.app').getBoundingClientRect();
          return {
            htmlBg: root.backgroundColor,
            bandHeight: band.height,
            bandBg: band.backgroundColor,
            meta: document.querySelector('meta[name="theme-color"]')?.content,
            cssBg: root.getPropertyValue('--bg').trim(),
            appHeight: app.height,
            scrollHeight: document.documentElement.scrollHeight,
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth: window.innerWidth,
          };
        });

        expect(state.cssBg).toBe(expected.hex);
        expect(state.htmlBg).toBe(expected.rgb);
        expect(state.bandHeight).toBe(`${inset}px`);
        expect(state.bandBg).toBe(expected.rgb);
        expect(state.meta).toBe(expected.hex);
        expect(state.scrollWidth).toBe(state.innerWidth);
        expect(Math.abs(state.scrollHeight - state.appHeight)).toBeLessThanOrEqual(1);

        const stats = await bandStats(page, inset);
        const distance = Math.max(...stats.modal.map((value, index) => Math.abs(value - Number(expected.rgb.split(/[^0-9]+/)[index + 1]))));
        expect(distance).toBeLessThanOrEqual(MAX_BG_DISTANCE);
        expect(stats.whiteRow).toBeLessThanOrEqual(MAX_WHITE_ROW);
      });
    }
  }
});

test.describe('theme-color before the app bundle runs', () => {
  test.use({ viewport: VIEWPORT, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  for (const [theme, expected] of Object.entries(THEMES)) {
    test(`first paint uses the ${theme} background`, async ({ page }) => {
      await page.goto('/');
      // Drop the service worker so its cache cannot answer the blocked bundle.
      await page.evaluate(async () => {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((registration) => registration.unregister()));
      });
      await page.evaluate((value) => localStorage.setItem('localtune-theme', value), theme);
      await page.route('**/assets/*.js', (route) => route.abort());
      await page.reload({ waitUntil: 'load' });
      await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', expected.hex);
    });
  }
});

test.describe('desktop keeps the band at zero height', () => {
  test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false });

  test('no safe-area band or layout shift', async ({ page }) => {
    await page.goto('/');
    const state = await page.evaluate(() => ({
      bandHeight: getComputedStyle(document.body, '::after').height,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      appHeight: document.querySelector('.app').getBoundingClientRect().height,
      scrollHeight: document.documentElement.scrollHeight,
    }));
    expect(state.bandHeight).toBe('0px');
    expect(state.scrollWidth).toBe(state.innerWidth);
    expect(Math.abs(state.scrollHeight - state.appHeight)).toBeLessThanOrEqual(1);
  });
});
