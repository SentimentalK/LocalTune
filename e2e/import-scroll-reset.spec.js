import { expect, test } from '@playwright/test';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test.use({
  locale: 'en-US',
  launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] },
});

const FILES = 200;
const SAMPLE_MS = 12_000;
const SAMPLE = path.resolve(fileURLToPath(new URL('../tests/fixtures/sample.mp3', import.meta.url)));

/**
 * The import copies the files, then reads their ID3 tags in the background and
 * emits one refresh per second. Slowing `arrayBuffer` stretches that backfill
 * so the scroll position stays under observation while rows keep changing.
 */
function slowTagReads(page) {
  return page.addInitScript(() => {
    const proto = Blob.prototype;
    if (proto.__slowRead) return;
    const original = proto.arrayBuffer;
    Object.defineProperty(proto, '__slowRead', { value: true });
    proto.arrayBuffer = async function arrayBuffer(...args) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return original.apply(this, args);
    };
  });
}

async function makeImportDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'localtune-scroll-'));
  for (let index = 0; index < FILES; index += 1) {
    await copyFile(SAMPLE, path.join(dir, `track-${String(index).padStart(3, '0')}.mp3`));
  }
  return dir;
}

function switchToImportMode(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('localtune');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('meta', 'readwrite');
          tx.objectStore('meta').put({ key: 'localMode', value: 'import' });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
}

/** Start the import and return to the library while the tag backfill runs. */
async function importAndOpenLibrary(page, dir, mobile) {
  await page.goto('/');
  await expect(page.locator('.wordmark')).toBeVisible();
  await switchToImportMode(page);
  await page.reload();
  await expect(page.locator('#status')).toBeHidden({ timeout: 30_000 });
  await page.locator('[data-testid="settings-open"]').click();

  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('[data-testid="source-connect-local"]').click();
  const chooser = await chooserPromise;
  await chooser.setFiles(dir);

  await page.waitForTimeout(400);
  if (mobile) await page.locator('[data-testid="settings-open"]').click();
  else await page.locator('[data-testid="panel-open"]').click();
  await page.locator('[data-testid="folder-source-local"]').click({ timeout: 30_000 });
  await page.locator('#trackList [data-testid="track-row"]').first().waitFor({ timeout: 90_000 });
}

/** Wait for the whole import to be listed; the backfill keeps emitting after. */
async function waitForFullLibrary(page) {
  await expect(page.locator('#libraryKicker')).toContainText(String(FILES), { timeout: 90_000 });
  await expect(page.locator('#trackList .track-list')).toHaveCount(1);
}

async function frames(page, count = 3) {
  await page.evaluate(
    (n) =>
      new Promise((resolve) => {
        const step = (left) =>
          left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1));
        step(n);
      }),
    count,
  );
}

async function rowStride(page) {
  const rows = page.locator('#trackList [data-testid="track-row"]');
  if ((await rows.count()) >= 2) {
    const first = await rows.nth(0).boundingBox();
    const second = await rows.nth(1).boundingBox();
    if (first && second) {
      const diff = Math.round(second.y - first.y);
      if (diff > 0) return diff;
    }
  }
  // Rows are equal height; the CSS gap is 2px (the virtualizer adds it too).
  return Math.round(
    await rows.first().evaluate((row) => row.getBoundingClientRect().height + 2),
  );
}

/**
 * Watch the mounted lists for `duration`. `kept` counts the `.track-list`
 * containers that survived: an in-place repaint keeps them, a rebuild swaps
 * them out. `paints` counts child-list writes of a whole window.
 */
function sampleScroll(page, duration) {
  return page.evaluate(
    (ms) =>
      new Promise((resolve) => {
        const scroller = document.getElementById('listScroll');
        const lists = Array.from(document.querySelectorAll('#trackList .track-list'));
        lists.forEach((node, index) => {
          node.dataset.axProbe = String(index);
        });
        const samples = [];
        let paints = 0;
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            if (record.type === 'childList' && record.addedNodes.length >= 5) paints += 1;
          }
        });
        observer.observe(document.getElementById('trackList'), {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
        });
        const started = performance.now();
        const baselineTop = Math.round(scroller.scrollTop);
        const baselineY = Math.round(window.scrollY);
        const tick = () => {
          samples.push({ top: Math.round(scroller.scrollTop), y: Math.round(window.scrollY) });
          if (performance.now() - started < ms) {
            requestAnimationFrame(tick);
            return;
          }
          observer.disconnect();
          const overflow = getComputedStyle(scroller).overflowY;
          const pageMode = overflow !== 'auto' && overflow !== 'scroll';
          const box = scroller.getBoundingClientRect();
          const viewTop = pageMode ? 0 : box.top;
          const viewBottom = pageMode ? window.innerHeight : box.bottom;
          const visibleTitles = [];
          for (const row of document.querySelectorAll('#trackList [data-testid="track-row"]')) {
            const rowBox = row.getBoundingClientRect();
            if (rowBox.bottom <= viewTop || rowBox.top >= viewBottom) continue;
            visibleTitles.push(row.querySelector('.track-text strong')?.textContent ?? '');
          }
          resolve({
            baselineTop,
            baselineY,
            samples,
            paints,
            lists: lists.length,
            kept: lists.filter((node) => node.isConnected).length,
            header: document.getElementById('libraryKicker')?.textContent ?? '',
            listHeight: Math.max(
              0,
              ...Array.from(document.querySelectorAll('#trackList .track-list')).map(
                (node) => node.offsetHeight,
              ),
            ),
            visibleTitles,
          });
        };
        requestAnimationFrame(tick);
      }),
    duration,
  );
}

test.describe('library scroll while the tag backfill runs', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('the panel keeps its offset and rows update in place', async ({ page }) => {
    test.setTimeout(150_000);
    const dir = await makeImportDir();
    try {
      await slowTagReads(page);
      await importAndOpenLibrary(page, dir, false);
      await waitForFullLibrary(page);

      const stride = await rowStride(page);
      await page.evaluate(() => {
        const scroller = document.getElementById('listScroll');
        scroller.scrollTop = Math.round((scroller.scrollHeight - scroller.clientHeight) * 0.25);
      });
      await frames(page);

      const result = await sampleScroll(page, SAMPLE_MS);
      const tops = result.samples.map((sample) => sample.top);

      expect(result.baselineTop).toBeGreaterThan(0);
      expect(result.lists).toBeGreaterThanOrEqual(1);
      // No remount: the same window containers survived the whole backfill.
      expect(result.kept).toBe(result.lists);
      // The backfill kept emitting `change` (one refresh per emit, at least).
      expect(result.paints).toBeGreaterThanOrEqual(3);
      expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(stride);
      expect(Math.min(...tops)).toBeGreaterThanOrEqual(result.baselineTop - stride);
      expect(result.header).toContain(String(FILES));
      expect(Math.abs(result.listHeight - FILES * stride)).toBeLessThanOrEqual(2 * stride);
      // Rows actually repainted: a visible title has been backfilled.
      expect(result.visibleTitles).toContain('Night Drive');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test.describe('page scroll while the tag backfill runs', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the page keeps its offset and rows update in place', async ({ page }) => {
    test.setTimeout(150_000);
    const dir = await makeImportDir();
    try {
      await slowTagReads(page);
      await importAndOpenLibrary(page, dir, true);
      await waitForFullLibrary(page);

      const stride = await rowStride(page);
      await page.evaluate(() => {
        const scroller = document.getElementById('listScroll');
        window.scrollTo(
          0,
          Math.round(
            scroller.getBoundingClientRect().top +
              window.scrollY +
              scroller.scrollHeight * 0.25,
          ),
        );
      });
      await frames(page);

      const result = await sampleScroll(page, SAMPLE_MS);
      const ys = result.samples.map((sample) => sample.y);

      expect(result.baselineY).toBeGreaterThan(0);
      expect(result.lists).toBeGreaterThanOrEqual(1);
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(result.baselineY - stride);
      expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(stride);
      expect(result.kept).toBe(result.lists);
      expect(result.paints).toBeGreaterThanOrEqual(3);
      expect(result.header).toContain(String(FILES));
      expect(Math.abs(result.listHeight - FILES * stride)).toBeLessThanOrEqual(2 * stride);
      expect(result.visibleTitles).toContain('Night Drive');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
