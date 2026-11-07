import { expect, test } from '@playwright/test';

test.use({
  launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] },
});

// The chalk layer is pure decoration over the deck: it must never eat a gesture,
// never cover the chrome, and must keep its arrow tips a measured distance off
// the two controls it points at. The layer mounts with the deck (no "first run"
// or demo gate), so the demo queue is the only fixture these tests need.
const PORT = Number(process.env.PW_PORT ?? 4173);
const ORIGIN = `http://127.0.0.1:${PORT}`;

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
];

// App locale → browser locale and the handwriting face styles.css picks.
const LOCALES = [
  { code: 'zh-CN', browser: 'zh-CN', family: 'ChalkZh' },
  { code: 'zh-TW', browser: 'zh-TW', family: 'ChalkTw' },
  { code: 'en', browser: 'en-US', family: 'ChalkLat' },
  { code: 'ja', browser: 'ja-JP', family: 'ChalkJa' },
  { code: 'ko', browser: 'ko-KR', family: 'ChalkKo' },
  { code: 'ru', browser: 'ru-RU', family: 'ChalkRu' },
  { code: 'de', browser: 'de-DE', family: 'ChalkLat' },
  { code: 'es', browser: 'es-ES', family: 'ChalkLat' },
  { code: 'fr', browser: 'fr-FR', family: 'ChalkLat' },
  { code: 'pt-BR', browser: 'pt-BR', family: 'ChalkLat' },
];

async function openDemo(page) {
  await page.goto('/');
  await expect(page.locator('.track-item.queue')).toHaveCount(4);
  await expect(page.locator('.chalk-layer')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

// Touch swipe on the stage: negative dx = next, positive dx = previous. Same
// synthetic-pointer approach as e2e/gestures.spec.js.
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

/** Union bbox of every visible chalk path/text, against the named chrome. */
function inkAgainstChrome() {
  const layer = document.querySelector('.chalk-layer');
  const boxes = [...layer.querySelectorAll('path, text')]
    .map((node) => node.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0);
  const ink = boxes.reduce(
    (acc, rect) => ({
      left: Math.min(acc.left, rect.left),
      top: Math.min(acc.top, rect.top),
      right: Math.max(acc.right, rect.right),
      bottom: Math.max(acc.bottom, rect.bottom),
    }),
    { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
  );
  const groups = {
    icons: [...document.querySelectorAll('.icon-btn')]
      .map((node) => node.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0).length,
    tabs: [...document.querySelectorAll('.tabs')]
      .map((node) => node.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0).length,
    search: document.querySelector('input[data-testid="search-input"]') ? 1 : 0,
  };
  const chrome = [
    ...document.querySelectorAll('.icon-btn'),
    ...document.querySelectorAll('.tabs'),
    document.querySelector('input[data-testid="search-input"]'),
  ]
    .filter((node) => node)
    .map((node) => ({ name: String(node.className || node.id), rect: node.getBoundingClientRect() }))
    .filter((entry) => entry.rect.width > 0 && entry.rect.height > 0);
  const overlaps = chrome.filter((entry) => {
    const x = Math.min(ink.right, entry.rect.right) - Math.max(ink.left, entry.rect.left);
    const y = Math.min(ink.bottom, entry.rect.bottom) - Math.max(ink.top, entry.rect.top);
    return x > 0.5 && y > 0.5;
  });
  const icons = [...document.querySelectorAll('.icon-btn')]
    .map((node) => node.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0);
  const deck = document.querySelector('.deck').getBoundingClientRect();
  const scale = deck.width / 640;
  return {
    ink: { left: ink.left, top: ink.top, right: ink.right, bottom: ink.bottom },
    groups,
    chrome: chrome.length,
    overlaps: overlaps.map((entry) => entry.name),
    // Same numbers in deck units, for the gutter assertion below.
    inkTopUnits: (ink.top - deck.top) / scale,
    iconBottomUnits: icons.length
      ? (Math.max(...icons.map((rect) => rect.bottom)) - deck.top) / scale
      : -Infinity,
    inkTopGapPx: icons.length
      ? ink.top - Math.max(...icons.map((rect) => rect.bottom))
      : Infinity,
  };
}

/** Tip distance to `.hub-hit`'s circle edge and to `.arm-head-hit`'s rect box. */
function tipDistances() {
  const layer = document.querySelector('.chalk-layer');
  const center = (node) => {
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  };
  const hub = document.querySelector('.hub-hit');
  const hubRect = hub.getBoundingClientRect();
  const deck = document.querySelector('.deck').getBoundingClientRect();
  const scale = deck.width / 640;
  const hubRadius = 36 * scale; // `.hub-hit` is <circle r="36"> in the 640-unit deck
  const play = center(layer.querySelector('[data-tip="hub"]'));
  const seek = center(layer.querySelector('[data-tip="head"]'));
  const headRect = document.querySelector('.arm-head-hit').getBoundingClientRect();
  return {
    play: Math.hypot(play.x - (hubRect.left + hubRect.width / 2), play.y - (hubRect.top + hubRect.height / 2)) - hubRadius,
    seek: Math.hypot(
      Math.max(headRect.left - seek.x, 0, seek.x - headRect.right),
      Math.max(headRect.top - seek.y, 0, seek.y - headRect.bottom),
    ),
  };
}

test('the chalk layer never intercepts the deck controls', async ({ page }) => {
  await openDemo(page);

  expect(
    await page.locator('.chalk-layer').evaluate((node) => getComputedStyle(node).pointerEvents),
  ).toBe('none');

  // The topmost element at the arm base's centre is the control itself.
  expect(
    await page.evaluate(() => {
      const rect = document.querySelector('.hub-hit').getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit?.getAttribute('class') ?? '';
    }),
  ).toContain('hub-hit');

  // A real click (no force) proves nothing is painted over the hit area.
  await page.locator('.hub-hit').click();
  await expect(page.locator('#armRotor')).toHaveAttribute('data-playing', 'true');

  await swipe(page, -120);
  await expect(page.locator('.song')).toHaveText('JUST COMMUNICATION');
});

for (const viewport of VIEWPORTS) {
  test(`the chalk ink stays out of the chrome at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await openDemo(page);
    const result = await page.evaluate(inkAgainstChrome);
    // 3 icon buttons on a phone (the menu toggle is hidden), 4 on desktop,
    // plus the tab strip and the search field.
    expect(result.groups.icons).toBeGreaterThanOrEqual(3);
    expect(result.groups.tabs).toBe(1);
    expect(result.groups.search).toBe(1);
    expect(result.chrome).toBeGreaterThanOrEqual(5);
    expect(result.overlaps).toEqual([]);
    expect(result.ink.right).toBeGreaterThan(result.ink.left);
    // The ink keeps a real gutter below the toolbar band: 16 deck units, which
    // is at least 4 CSS px at both viewports.
    expect(result.inkTopUnits).toBeGreaterThanOrEqual(result.iconBottomUnits + 16);
    expect(result.inkTopGapPx).toBeGreaterThanOrEqual(4);
  });
}

for (const viewport of VIEWPORTS) {
  test(`each arrow tip sits 6–10px off its control at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await openDemo(page);
    const gaps = await page.evaluate(tipDistances);
    expect(gaps.play).toBeGreaterThanOrEqual(6);
    expect(gaps.play).toBeLessThanOrEqual(10);
    expect(gaps.seek).toBeGreaterThanOrEqual(6);
    expect(gaps.seek).toBeLessThanOrEqual(10);
  });
}

test('every locale shares one caption size', async ({ browser }) => {
  const sizes = [];
  for (const locale of LOCALES) {
    const context = await browser.newContext({
      locale: locale.browser,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    await expect(page.locator('.chalk-layer text').first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const measured = await page.evaluate(() => {
      const deck = document.querySelector('.deck').getBoundingClientRect();
      const scale = deck.width / 640;
      return [...document.querySelectorAll('.chalk-layer text')].map(
        (node) => parseFloat(getComputedStyle(node).fontSize) / scale,
      );
    });
    sizes.push({ code: locale.code, play: measured[0], seek: measured.slice(1) });
    await context.close();
  }
  const plays = sizes.map((row) => row.play);
  const seeks = sizes.flatMap((row) => row.seek);
  expect(Math.min(...plays)).toBeGreaterThanOrEqual(28);
  expect(Math.max(...plays) - Math.min(...plays)).toBeLessThanOrEqual(2);
  expect(Math.min(...seeks)).toBeGreaterThanOrEqual(28);
  expect(Math.max(...seeks) - Math.min(...seeks)).toBeLessThanOrEqual(2);
  expect(sizes.map((row) => row.code)).toEqual(LOCALES.map((locale) => locale.code));
});

test('every locale renders its caption in the bundled face', async ({ browser }) => {
  for (const locale of LOCALES) {
    const context = await browser.newContext({
      locale: locale.browser,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    await expect(page.locator('.chalk-layer text')).toHaveCount(3);
    await page.evaluate(() => document.fonts.ready);

    const seen = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('.chalk-layer text')];
      const family = getComputedStyle(nodes[0])
        .fontFamily.split(',')[0]
        .replace(/["']/g, '')
        .trim();
      return {
        lang: document.documentElement.lang,
        texts: nodes.map((node) => (node.textContent ?? '').trim()),
        family,
        loaded: [...document.fonts]
          .filter((face) => face.status === 'loaded')
          .map((face) => face.family.replace(/["']/g, '')),
        check: document.fonts.check(`30px "${family}"`, nodes[0].textContent ?? ''),
      };
    });

    expect(seen.lang, locale.code).toBe(locale.code);
    expect(seen.family, locale.code).toBe(locale.family);
    expect(seen.texts.every((text) => text.length > 0), locale.code).toBe(true);
    expect(seen.loaded, locale.code).toContain(locale.family);
    expect(seen.check, locale.code).toBe(true);
    await context.close();
  }
});
