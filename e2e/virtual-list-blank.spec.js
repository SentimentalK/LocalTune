import { expect, test } from '@playwright/test';

/**
 * APP-001-AV regression: switching tabs, reopening the panel or resizing used
 * to leave the list area blank. The virtualizer painted its first window at the
 * clamped scroll offset and nothing re-anchored it afterwards, so the DOM held
 * rows the viewport was not looking at.
 *
 * Every probe counts the rows that actually intersect the scroller, so a window
 * parked at the wrong offset fails even though the DOM is populated, and the
 * tests never scroll or move the pointer to "wake" the list up.
 */

const COUNT = 97;
const MTIME = 1_700_000_000_000;

/** Seed 97 reference-mode tracks at the library root (`track-000.mp3`…). */
async function seedLibrary(page) {
  await page.evaluate(
    async ({ count, mtime }) => {
      const wav = (name) => {
        const sampleRate = 8000;
        const samples = sampleRate * 2;
        const bytes = 44 + samples * 2;
        const buffer = new ArrayBuffer(bytes);
        const view = new DataView(buffer);
        const ascii = (offset, text) => {
          for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
        };
        ascii(0, 'RIFF');
        view.setUint32(4, bytes - 8, true);
        ascii(8, 'WAVE');
        ascii(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        ascii(36, 'data');
        view.setUint32(40, samples * 2, true);
        return new File([buffer], name, { type: 'audio/wav', lastModified: mtime });
      };

      const file = wav('silence.wav');
      const paths = Array.from(
        { length: count },
        (_, index) => `track-${String(index).padStart(3, '0')}.mp3`,
      );

      await new Promise((resolve, reject) => {
        const open = indexedDB.open('localtune');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(['tracks', 'meta'], 'readwrite');
          const tracks = tx.objectStore('tracks');
          const meta = tx.objectStore('meta');
          tracks.clear();
          paths.forEach((path, index) => {
            tracks.put({
              id: `fsa:${path}`,
              path,
              title: `Track ${String(index + 1).padStart(3, '0')}`,
              artist: `Artist ${index % 7}`,
              album: `Album ${index % 11}`,
              year: null,
              trackNo: null,
              duration: 180,
              mtime,
              size: file.size,
              cover: null,
              source: 'fsa',
              externalIds: {},
            });
          });
          meta.put({ key: 'demoDismissed', value: true });
          meta.put({ key: 'localMode', value: 'reference' });
          meta.put({ key: 'fileList', value: paths.map((path) => ({ path, file })) });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      });
    },
    { count: COUNT, mtime: MTIME },
  );
}

/** Seed, reload and land on the local source root listing. */
async function openLibrary(page) {
  await page.goto('/');
  await expect(page.locator('#status')).toBeHidden({ timeout: 30_000 });
  await seedLibrary(page);
  await page.reload();
  await expect(page.locator('#status')).toBeHidden({ timeout: 30_000 });
  // The panel starts expanded on desktop, so the list can be measured.
  await expect(page.locator('[data-testid="panel-open"]')).toHaveAttribute('aria-expanded', 'true');
  await page.locator('#tab-folders').click();
  await page.locator('[data-testid="folder-source-local"]').click();
  await expect(page.locator('#trackList .track-item').first()).toBeVisible();
}

/**
 * Rows that intersect the scroller's visible rect. Only meaningful when the
 * scroller clips (`overflow-y: auto|scroll`); in the page-scroll (mobile)
 * layout it reports the painted window instead, which is what "not blank"
 * means there.
 */
const visibleRows = (page, selector = '#trackList .track-item') =>
  page.evaluate((scope) => {
    const scroller = document.getElementById('listScroll');
    const rows = [...document.querySelectorAll(scope)];
    if (!scroller) return 0;
    const overflow = getComputedStyle(scroller).overflowY;
    if (overflow !== 'auto' && overflow !== 'scroll') return rows.length;
    const box = scroller.getBoundingClientRect();
    return rows.filter((row) => {
      const rect = row.getBoundingClientRect();
      return rect.height > 0 && rect.bottom > box.top && rect.top < box.bottom;
    }).length;
  }, selector);

/**
 * Scroller height, row pitch, scroll offset and how many rows fit.
 *
 * The row count is taken from the visible part of the list itself: the folder
 * header (and the queue head) sit inside the scroller above the rows, so the
 * scroller's height alone would claim one row more than can ever be seen.
 */
const listMetrics = (page) =>
  page.evaluate(() => {
    const scroller = document.getElementById('listScroll');
    const list = document.querySelector('#trackList .track-list');
    const rows = [...document.querySelectorAll('#trackList .track-item')];
    const first = rows[0]?.getBoundingClientRect();
    const second = rows[1]?.getBoundingClientRect();
    const stride =
      first && second && second.top > first.top ? second.top - first.top : first ? first.height + 2 : 66;
    const box = scroller?.getBoundingClientRect();
    const listBox = list?.getBoundingClientRect();
    const top = Math.max(box?.top ?? 0, listBox?.top ?? box?.top ?? 0);
    const bottom = Math.min(box?.bottom ?? 0, listBox?.bottom ?? box?.bottom ?? 0);
    const visibleHeight = Math.max(0, bottom - top);
    return {
      clientHeight: scroller?.clientHeight ?? 0,
      stride,
      scrollTop: scroller?.scrollTop ?? 0,
      rowsThatFit: stride > 0 ? Math.ceil(visibleHeight / stride) : 0,
    };
  });

/** Poll until the visible rows cover the measurement the list itself uses. */
async function expectFilledWindow(page, timeout = 2_000, selector) {
  const { rowsThatFit, clientHeight, stride } = await listMetrics(page);
  expect(clientHeight).toBeGreaterThan(0);
  expect(rowsThatFit).toBeGreaterThan(0);
  await expect
    .poll(() => visibleRows(page, selector), { timeout })
    .toBeGreaterThanOrEqual(rowsThatFit);
}

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('the folder list paints a full window and keeps all rows in the DOM', async ({ page }) => {
    await openLibrary(page);

    await expectFilledWindow(page);
    await expect(page.locator('#libraryKicker')).toContainText(String(COUNT));

    const { stride } = await listMetrics(page);
    const listHeight = await page.evaluate(() => {
      const list = document.querySelector('#trackList .track-list');
      return list ? list.offsetHeight : 0;
    });
    // The whole 97-row list is in the scroll content; only the window is in the DOM.
    expect(Math.abs(listHeight - COUNT * stride)).toBeLessThanOrEqual(stride);
  });

  test('the queue and folder tabs stay filled, and search results render', async ({ page }) => {
    await openLibrary(page);

    await page.locator('[data-testid="folder-play-all"]').click();
    await page.locator('#tab-queue').click();
    await expectFilledWindow(page);

    await page.locator('#tab-folders').click();
    await expectFilledWindow(page);

    await page.locator('[data-testid="search-input"]').fill('Track');
    await expect(page.locator('[data-testid="search-group-title"]')).toBeVisible();
    await expect
      .poll(() => visibleRows(page, '#trackList .search-group .track-item'), { timeout: 2_000 })
      .toBeGreaterThanOrEqual(1);
  });

  test('reopening the panel paints rows immediately and then fills the view', async ({ page }) => {
    await openLibrary(page);

    await page.locator('[data-testid="panel-open"]').click();
    await page.waitForTimeout(700);
    await expect(page.locator('[data-testid="panel-open"]')).toHaveAttribute('aria-expanded', 'false');

    await page.locator('[data-testid="panel-open"]').click();
    expect(await page.locator('#trackList .track-item').count()).toBeGreaterThan(0);

    await page.waitForTimeout(600);
    await expectFilledWindow(page, 1_000);
  });

  test('resizing repaints a filled window', async ({ page }) => {
    await openLibrary(page);
    await expectFilledWindow(page);

    // 900px crosses PANEL_BREAKPOINT: the panel becomes the mobile overlay,
    // #listScroll stops clipping and the rows sit below the fold, so "visible
    // rows" is not a desktop measurement there. The list must simply stay
    // populated instead of being cleared.
    await page.setViewportSize({ width: 900, height: 800 });
    await page.waitForTimeout(600);
    expect(await page.locator('#trackList .track-item').count()).toBeGreaterThan(0);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(600);
    await expectFilledWindow(page, 1_000);
  });

  test('switching tabs keeps a scrolled list anchored', async ({ page }) => {
    await openLibrary(page);

    await page.locator('#listScroll').evaluate((node) => {
      node.scrollTop = 2000;
    });
    await expect
      .poll(() => page.evaluate(() => document.getElementById('listScroll').scrollTop))
      .toBe(2000);

    await page.locator('#tab-queue').click();
    await page.locator('#tab-folders').click();

    // No wheel, no pointer move: the list must re-anchor on its own.
    await expectFilledWindow(page);
    expect(await page.evaluate(() => document.getElementById('listScroll').scrollTop)).toBeGreaterThan(0);
    await expect(page.locator('#trackList .track-item').first()).toBeVisible();
  });
});
