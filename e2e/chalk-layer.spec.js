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

/**
 * Every visible chalk path/text box, against the chrome the layer must not
 * cover. Boxes never intersect, and the closest approach keeps a real gutter.
 */
function inkAgainstChrome() {
  const layer = document.querySelector('.chalk-layer');
  const boxes = [...layer.querySelectorAll('path, text')]
    .map((node) => ({ name: node.textContent?.slice(0, 12) || node.tagName, rect: node.getBoundingClientRect() }))
    .filter((entry) => entry.rect.width > 0 && entry.rect.height > 0);
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
  let closest = Infinity;
  const overlaps = [];
  for (const box of boxes) {
    for (const entry of chrome) {
      const dx = Math.max(entry.rect.left - box.rect.right, 0, box.rect.left - entry.rect.right);
      const dy = Math.max(entry.rect.top - box.rect.bottom, 0, box.rect.top - entry.rect.bottom);
      const gap = Math.hypot(dx, dy);
      if (gap < closest) closest = gap;
      if (gap === 0) overlaps.push(`${box.name || 'path'} × ${entry.name}`);
    }
  }
  return { groups, chrome: chrome.length, boxes: boxes.length, closest, overlaps };
}

/** Closest approach of each chalk text box to the record's inner 0.92 R disc. */
function textAgainstArt() {
  const vinyl = document.querySelector('.vinyl').getBoundingClientRect();
  const cx = vinyl.left + vinyl.width / 2;
  const cy = vinyl.top + vinyl.height / 2;
  const radius = (vinyl.width / 2) * 0.92;
  return [...document.querySelectorAll('.chalk-layer text')].map((node) => {
    const box = node.getBoundingClientRect();
    const px = Math.min(Math.max(cx, box.left), box.right);
    const py = Math.min(Math.max(cy, box.top), box.bottom);
    const distance = Math.hypot(px - cx, py - cy);
    return { text: node.textContent, distance, radius, inside: distance < radius };
  });
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
    expect(result.boxes).toBeGreaterThan(0);
    expect(result.overlaps).toEqual([]);
    expect(result.closest).toBeGreaterThanOrEqual(2);
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

// The scratch arc sweeps around the record's lower-left; the 33⅓ chip is a
// real control in the same corner. The arc's bounding box covers the chip's
// box even though the ink never does, so this samples the path points.
for (const viewport of VIEWPORTS) {
  test(`the scratch hint stays off the rpm chip at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await openDemo(page);
    const gap = await page.evaluate(() => {
      const deck = document.querySelector('.deck').getBoundingClientRect();
      const scale = deck.width / 640;
      const rpm = document.querySelector('.rpm-switch').getBoundingClientRect();
      const toPx = (x, y) => ({ x: deck.left + x * scale, y: deck.top + y * scale });
      let closest = Infinity;
      for (const node of document.querySelectorAll('.chalk-anno[data-anno="scratch"] path')) {
        const numbers = (node.getAttribute('d') ?? '').match(/-?\d+(?:\.\d+)?/g) ?? [];
        for (let index = 0; index + 1 < numbers.length; index += 2) {
          const point = toPx(Number(numbers[index]), Number(numbers[index + 1]));
          const dx = Math.max(rpm.left - point.x, 0, point.x - rpm.right);
          const dy = Math.max(rpm.top - point.y, 0, point.y - rpm.bottom);
          closest = Math.min(closest, Math.hypot(dx, dy));
        }
      }
      return closest / scale;
    });
    expect(gap).toBeGreaterThanOrEqual(2);
  });
}

test('no locale lets a caption touch the record artwork', async ({ browser }) => {
  for (const locale of LOCALES) {
    const context = await browser.newContext({
      locale: locale.browser,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    await expect(page.locator('.chalk-layer text').first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const rows = await page.evaluate(textAgainstArt);
    for (const row of rows) {
      expect(row.inside, `${locale.code} ${row.text}`).toBe(false);
      expect(row.distance - row.radius, `${locale.code} ${row.text}`).toBeGreaterThanOrEqual(0);
    }
    await context.close();
  }
});

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
      const groups = {};
      for (const node of document.querySelectorAll('.chalk-layer text')) {
        const anno = node.closest('.chalk-anno')?.getAttribute('data-anno') ?? 'other';
        (groups[anno] ??= []).push(parseFloat(getComputedStyle(node).fontSize) / scale);
      }
      return groups;
    });
    sizes.push({ code: locale.code, groups: measured });
    await context.close();
  }
  // One size per annotation, identical for every locale: a translation may
  // never shrink its caption (or the hint starts looking like a bug).
  const byAnno = {};
  for (const row of sizes) {
    for (const [anno, list] of Object.entries(row.groups)) {
      byAnno[anno] = [...(byAnno[anno] ?? []), ...list];
    }
  }
  expect(Object.keys(byAnno).sort()).toEqual(['play', 'scratch', 'seek']);
  for (const [anno, list] of Object.entries(byAnno)) {
    expect(Math.max(...list) - Math.min(...list), anno).toBeLessThanOrEqual(2);
  }
  expect(Math.min(...byAnno.play)).toBeGreaterThanOrEqual(28);
  expect(Math.min(...byAnno.seek)).toBeGreaterThanOrEqual(28);
  expect(Math.min(...byAnno.scratch)).toBeGreaterThanOrEqual(22);
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
    await expect(page.locator('.chalk-layer text')).toHaveCount(4);
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
        // Every caption, not just the first: a glyph missing from the subset
        // silently falls back to the system cursive face.
        checks: nodes.map((node) =>
          document.fonts.check(
            `${getComputedStyle(node).fontSize} "${family}"`,
            node.textContent ?? '',
          ),
        ),
      };
    });

    expect(seen.lang, locale.code).toBe(locale.code);
    expect(seen.family, locale.code).toBe(locale.family);
    expect(seen.texts.every((text) => text.length > 0), locale.code).toBe(true);
    expect(seen.loaded, locale.code).toContain(locale.family);
    expect(seen.checks.every(Boolean), `${locale.code} ${seen.texts.join(' | ')}`).toBe(true);
    await context.close();
  }
});

test('the chalk hint hides while the demo plays and returns on pause', async ({ page }) => {
  await openDemo(page);
  const layer = page.locator('.chalk-layer');
  await expect(layer).not.toHaveClass(/is-hidden/);
  await expect
    .poll(() => layer.evaluate((node) => Number(getComputedStyle(node).opacity) > 0.99))
    .toBe(true);

  await page.locator('.hub-hit').click();
  await expect(page.locator('#armRotor')).toHaveAttribute('data-playing', 'true');
  await expect(layer).toHaveClass(/is-hidden/);
  await expect
    .poll(() => layer.evaluate((node) => getComputedStyle(node).visibility))
    .toBe('hidden');
  expect(
    await page.evaluate(() => {
      const node = document.querySelector('.chalk-layer text');
      const rect = node.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return Boolean(hit?.closest?.('.chalk-layer'));
    }),
  ).toBe(false);

  await page.locator('.hub-hit').click();
  await expect(page.locator('#armRotor')).toHaveAttribute('data-playing', 'false');
  await expect(layer).not.toHaveClass(/is-hidden/);
  await expect
    .poll(() => layer.evaluate((node) => getComputedStyle(node).visibility))
    .toBe('visible');
  await expect
    .poll(() => layer.evaluate((node) => Number(getComputedStyle(node).opacity) > 0.99))
    .toBe(true);
});

test('a queue without demo tracks keeps the hint hidden', async ({ page }) => {
  page.on('dialog', (dialog) => dialog.accept());
  await openDemo(page);
  const layer = page.locator('.chalk-layer');
  await expect(layer).not.toHaveClass(/is-hidden/);

  await page.locator('[data-testid="queue-clear"]').click();
  await expect(page.locator('.track-item.queue')).toHaveCount(0);
  await expect(layer).toHaveClass(/is-hidden/);
  await expect
    .poll(() => layer.evaluate((node) => getComputedStyle(node).visibility))
    .toBe('hidden');

  // Persist the dismissal directly and reload: a boot with no demo queue is
  // hidden from the first frame too.
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('localtune', 6);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('meta', 'readwrite');
          tx.objectStore('meta').put({ key: 'demoDismissed', value: true });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        open.onerror = () => reject(open.error);
      }),
  );
  await page.reload();
  await expect(page.locator('.track-item.queue')).toHaveCount(0);
  await expect(layer).toHaveClass(/is-hidden/);
  await expect
    .poll(() => layer.evaluate((node) => getComputedStyle(node).visibility))
    .toBe('hidden');
});

test('hiding the hint leaves the deck geometry alone', async ({ page }) => {
  await openDemo(page);
  // The library panel slides open on boot (width transition), which reflows the
  // stage; let it settle before sampling so only the chalk toggle is compared.
  await page.waitForTimeout(700);
  const measure = () =>
    page.evaluate(() => {
      const deck = document.querySelector('.deck').getBoundingClientRect();
      return {
        scroll: document.scrollingElement.scrollTop,
        x: deck.x,
        y: deck.y,
        width: deck.width,
        height: deck.height,
      };
    });
  const before = await measure();
  await page.locator('.hub-hit').click();
  await expect(page.locator('.chalk-layer')).toHaveClass(/is-hidden/);
  await page.waitForTimeout(400);
  expect(await measure()).toEqual(before);
});
