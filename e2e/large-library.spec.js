import { expect, test } from '@playwright/test';

/**
 * 1000-row library: proves the lists stay windowed in the folder, queue and
 * search views, keeps object URLs bounded while scrolling, and records the
 * long-task picture on desktop (max/p95 are logged for the perf report).
 */

const COUNT = 1000;
const MTIME = 1_700_000_000_000;
const MAX_ROWS = 60;

const trackId = (index) => `fsa:Music/track-${String(index).padStart(4, '0')}.mp3`;
const trackTitle = (index) => `Track ${String(index + 1).padStart(4, '0')}`;

/** Seed 1000 library rows with 1 KB covers plus one shared 2 s silent WAV. */
async function seedLargeLibrary(page) {
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
        // `lastModified` matches the seeded row mtime, so a rescan sees the
        // rows as unchanged and never rewrites the titles.
        return new File([buffer], name, { type: 'audio/wav', lastModified: mtime });
      };

      const file = wav('silence.wav');
      const paths = Array.from(
        { length: count },
        (_, index) => `Music/track-${String(index).padStart(4, '0')}.mp3`,
      );

      await new Promise((resolve, reject) => {
        const open = indexedDB.open('localtune');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(['tracks', 'covers', 'meta'], 'readwrite');
          const tracks = tx.objectStore('tracks');
          const covers = tx.objectStore('covers');
          const meta = tx.objectStore('meta');
          tracks.clear();
          covers.clear();
          paths.forEach((path, index) => {
            const id = `fsa:${path}`;
            tracks.put({
              id,
              path,
              title: `Track ${String(index + 1).padStart(4, '0')}`,
              artist: `Artist ${index % 40}`,
              album: `Album ${index % 80}`,
              duration: 180,
              mtime,
              size: file.size,
              hasCover: true,
              coverSize: 1024,
              coverType: 'image/png',
              source: 'fsa',
              externalIds: {},
            });
            // Opaque bytes on purpose: only the object-URL count matters here.
            covers.put({ id, cover: new Blob([new Uint8Array(1024)], { type: 'image/png' }) });
          });
          meta.put({ key: 'demoDismissed', value: true });
          meta.delete('playback');
          meta.put({ key: 'localMode', value: 'reference' });
          meta.put({
            key: 'fileList',
            value: paths.map((path) => ({ path, file })),
          });
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

/** Count object URLs and collect long tasks from the very first frame on. */
async function instrumentPage(page) {
  await page.addInitScript(() => {
    window.__coverUrls = { created: 0, revoked: 0 };
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (value) => {
      if (value instanceof Blob) window.__coverUrls.created += 1;
      return create(value);
    };
    URL.revokeObjectURL = (url) => {
      window.__coverUrls.revoked += 1;
      return revoke(url);
    };
    window.__longTasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__longTasks.push({ start: entry.startTime, duration: entry.duration });
        }
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      // Long-task observation is best effort.
    }
  });
}

async function openLargeLibrary(page) {
  await instrumentPage(page);
  await page.goto('/');
  await expect(page.locator('#status')).toBeHidden({ timeout: 30_000 });
  await seedLargeLibrary(page);
  await page.reload();
  await expect(page.locator('#status')).toBeHidden({ timeout: 30_000 });
  await page.locator('[data-testid="folder-source-local"]').click();
  await page.locator('[data-testid="folder-dir-Music"]').click();
  await expect(page.locator('#trackList [data-testid="track-row"]').first()).toBeVisible();
}

const frame = (page, count = 2) =>
  page.evaluate(
    (frames) =>
      new Promise((resolve) => {
        const step = (left) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
        step(frames);
      }),
    count,
  );

/** Vertical pitch of two adjacent rows (row height + list gap). */
async function rowStride(page) {
  const rows = page.locator('#trackList [data-testid="track-row"]');
  if ((await rows.count()) >= 2) {
    const first = await rows.nth(0).boundingBox();
    const second = await rows.nth(1).boundingBox();
    if (first && second) return second.y - first.y;
  }
  return page.evaluate(() => {
    const row = document.querySelector('#trackList [data-testid="track-row"]');
    return row ? row.getBoundingClientRect().height + 2 : 66;
  });
}

const listHeightFor = (page, id) =>
  page.evaluate((trackId) => {
    const row = document.querySelector(`[data-track-id="${trackId}"]`);
    return row?.closest('.track-list')?.offsetHeight ?? 0;
  }, id);

async function scrollListTo(page, top) {
  await page.evaluate((value) => {
    document.getElementById('listScroll').scrollTop = value;
  }, top);
  await frame(page);
}

const listMetrics = (page) =>
  page.evaluate(() => {
    const scroller = document.getElementById('listScroll');
    return { top: scroller.scrollTop, height: scroller.scrollHeight, client: scroller.clientHeight };
  });

async function longTaskStats(page) {
  return page.evaluate(() => {
    const durations = window.__longTasks.map((task) => task.duration).sort((a, b) => a - b);
    if (!durations.length) return { count: 0, max: 0, p95: 0 };
    const p95 = durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)];
    return { count: durations.length, max: durations[durations.length - 1], p95 };
  });
}

/** Clear the buffer, then walk the panel scroller to the bottom in 20 steps. */
async function measurePanelScroll(page, steps = 20) {
  await page.evaluate(() => {
    window.__longTasks.length = 0;
    document.getElementById('listScroll').scrollTop = 0;
  });
  await frame(page);
  await page.evaluate(async (count) => {
    const scroller = document.getElementById('listScroll');
    const max = scroller.scrollHeight - scroller.clientHeight;
    const nextFrame = () =>
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    for (let step = 1; step <= count; step += 1) {
      scroller.scrollTop = Math.round((max * step) / count);
      await nextFrame();
    }
  }, steps);
  // Chromium batches long-task reporting; give it room before reading.
  await page.waitForTimeout(1200);
  return longTaskStats(page);
}

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('folder and queue views window 1000 rows', async ({ page }) => {
    await openLargeLibrary(page);

    const rows = page.locator('#trackList [data-testid="track-row"]');
    const firstWindow = await rows.count();
    expect(firstWindow).toBeGreaterThan(0);
    expect(firstWindow).toBeLessThanOrEqual(MAX_ROWS);
    await expect(page.locator(`[data-track-id="${trackId(0)}"]`)).toBeVisible();

    const stride = await rowStride(page);
    const firstLongTasks = await longTaskStats(page);

    const { client } = await listMetrics(page);
    const middleTop = 500 * stride - Math.floor(client / 2);
    // Walk there in steps: a single jump would only ever hold one window's
    // covers, so the cache would never trim (and never revoke) them.
    for (let step = 1; step <= 6; step += 1) {
      await scrollListTo(page, Math.round((middleTop * step) / 6));
    }
    await expect(page.locator(`[data-track-id="${trackId(500)}"]`)).toBeVisible();
    expect(await rows.count()).toBeLessThanOrEqual(MAX_ROWS);

    const middleHeight = await listHeightFor(page, trackId(500));
    expect(middleHeight).toBeGreaterThan(0);
    expect(Math.abs(middleHeight - (COUNT * stride - 2))).toBeLessThanOrEqual(2 * stride);

    const covers = page.locator('#trackList img.track-cover[src^="blob:"]');
    await expect(covers.first()).toBeVisible();
    expect(await covers.count()).toBeLessThanOrEqual(await rows.count());
    const urls = await page.evaluate(() => ({ ...window.__coverUrls }));
    expect(urls.revoked).toBeGreaterThan(0);
    expect(urls.created - urls.revoked).toBeLessThanOrEqual(80);

    await page.evaluate(() => {
      const scroller = document.getElementById('listScroll');
      scroller.scrollTop = scroller.scrollHeight;
    });
    await frame(page);
    await expect(page.locator(`[data-track-id="${trackId(COUNT - 1)}"]`)).toBeVisible();
    expect(await rows.count()).toBeLessThanOrEqual(MAX_ROWS);

    const scrollLongTasks = await measurePanelScroll(page);
    console.log(
      `AJ perf desktop first=${JSON.stringify(firstLongTasks)} scroll=${JSON.stringify(scrollLongTasks)}`,
    );
    expect(scrollLongTasks.max).toBeLessThanOrEqual(500);
    expect(scrollLongTasks.p95).toBeLessThanOrEqual(200);

    // Playback from the middle window still resolves the clicked track.
    const { client: clientAgain } = await listMetrics(page);
    await scrollListTo(page, 500 * stride - Math.floor(clientAgain / 2));
    await page.locator(`[data-track-id="${trackId(500)}"] .track`).click();
    await expect(page.locator('.song')).toHaveText(trackTitle(500), { timeout: 8000 });

    // The queue takes all 1000 tracks and must stay windowed too.
    await page.locator('[data-testid="folder-play-all"]').click();
    await page.locator('#tab-queue').click();
    const queueRows = page.locator('#trackList .track-item');
    await expect(queueRows.first()).toBeVisible();
    expect(await queueRows.count()).toBeLessThanOrEqual(MAX_ROWS);

    const queueStride = await page.evaluate(() => {
      const row = document.querySelector('#trackList .track-item');
      return row ? row.getBoundingClientRect().height + 2 : 66;
    });
    const { client: queueClient } = await listMetrics(page);
    await scrollListTo(page, 500 * queueStride - Math.floor(queueClient / 2));
    await expect(page.locator('#trackList .track-index', { hasText: '501' })).toBeVisible();
    expect(await queueRows.count()).toBeLessThanOrEqual(MAX_ROWS);

    const before = await listMetrics(page);
    const queueCount = page.locator('.list-head .queue-head span').first();
    const totalBefore = await queueCount.textContent();
    const removeAt = Math.floor((await queueRows.count()) / 2);
    await page.locator('#trackList .track-item .row-x').nth(removeAt).click();
    await expect(queueCount).not.toHaveText(totalBefore ?? '');
    const totalAfter = await queueCount.textContent();
    expect(Number(totalAfter?.match(/\d+/)?.[0])).toBe(
      Number(totalBefore?.match(/\d+/)?.[0]) - 1,
    );
    const after = await listMetrics(page);
    expect(Math.abs(after.top - before.top)).toBeLessThan(100);
  });

  test('a hidden library view keeps the row count bounded', async ({ page }) => {
    await openLargeLibrary(page);

    const rows = page.locator('#trackList [data-testid="track-row"]');
    const stride = await rowStride(page);
    const baseline = await page.evaluate(
      () => document.querySelector('#trackList .track-list')?.offsetHeight ?? 0,
    );
    expect(baseline).toBeGreaterThan(0);

    await page.evaluate(() => {
      document.getElementById('libraryView').hidden = true;
      window.dispatchEvent(new Event('resize'));
    });
    await page.waitForTimeout(200);
    expect(await rows.count()).toBeLessThanOrEqual(MAX_ROWS);

    await page.evaluate(() => {
      document.getElementById('libraryView').hidden = false;
      window.dispatchEvent(new Event('resize'));
    });
    await page.waitForTimeout(200);
    const restored = await rows.count();
    expect(restored).toBeGreaterThan(0);
    expect(restored).toBeLessThanOrEqual(MAX_ROWS);

    const height = await page.evaluate(
      () => document.querySelector('#trackList .track-list')?.offsetHeight ?? 0,
    );
    expect(Math.abs(height - baseline)).toBeLessThanOrEqual(2 * stride);
  });
});

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('page scroll mode windows 1000 rows', async ({ page }) => {
    await openLargeLibrary(page);

    const rows = page.locator('#trackList [data-testid="track-row"]');
    expect(await rows.count()).toBeLessThanOrEqual(MAX_ROWS);
    const stride = await rowStride(page);
    const top = await page.evaluate(
      () => document.querySelector('#trackList .track-list').getBoundingClientRect().top + window.scrollY,
    );

    await page.evaluate((value) => window.scrollTo(0, value), top + 500 * stride - 100);
    await frame(page);
    await expect(page.locator(`[data-track-id="${trackId(500)}"]`)).toBeVisible();
    expect(await rows.count()).toBeLessThanOrEqual(MAX_ROWS);

    const height = await listHeightFor(page, trackId(500));
    expect(height).toBeGreaterThan(0);
    expect(Math.abs(height - (COUNT * stride - 2))).toBeLessThanOrEqual(2 * stride);

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await frame(page);
    await expect(page.locator(`[data-track-id="${trackId(COUNT - 1)}"]`)).toBeVisible();
    expect(await rows.count()).toBeLessThanOrEqual(MAX_ROWS);

    // Landscape phone: the page-mode window is re-measured, not re-rendered whole.
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(300);
    const rotated = await rows.count();
    expect(rotated).toBeGreaterThan(0);
    expect(rotated).toBeLessThanOrEqual(MAX_ROWS);
    const rotatedHeight = await page.evaluate(
      () => document.querySelector('#trackList .track-list')?.offsetHeight ?? 0,
    );
    expect(Math.abs(rotatedHeight - (COUNT * stride - 2))).toBeLessThanOrEqual(2 * stride);

    // Crossing the 900px breakpoint hands scrolling back to the panel.
    await page.setViewportSize({ width: 1000, height: 600 });
    await page.waitForTimeout(300);
    expect(
      await page.evaluate(() => getComputedStyle(document.getElementById('listScroll')).overflowY),
    ).toBe('auto');
    const desktopRows = await rows.count();
    expect(desktopRows).toBeGreaterThan(0);
    expect(desktopRows).toBeLessThanOrEqual(MAX_ROWS);
  });
});

test.describe('search', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('search groups stay windowed', async ({ page }) => {
    await openLargeLibrary(page);

    // Split the library so one query lands in two different groups: rows
    // 0-149 match by artist, 150-299 by album. Titles are blanked for every
    // row so the title group cannot swallow the hits (search is first-field-
    // wins and caps items at 200, so the album group keeps 50 of its 150).
    await page.evaluate(async () => {
      await new Promise((resolve, reject) => {
        const open = indexedDB.open('localtune');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(['tracks'], 'readwrite');
          const store = tx.objectStore('tracks');
          const read = store.getAll();
          read.onerror = () => reject(read.error);
          read.onsuccess = () => {
            for (const row of read.result) {
              const index = Number(/track-(\d+)\.mp3$/.exec(row.path ?? '')?.[1] ?? -1);
              if (index < 0) continue;
              row.title = `Song ${String(index + 1).padStart(4, '0')}`;
              if (index < 150) row.artist = `Zed Artist ${index}`;
              else if (index < 300) row.album = `Zed Album ${index}`;
              store.put(row);
            }
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      });
    });

    await page.reload();
    await expect(page.locator('#status')).toBeHidden({ timeout: 30_000 });
    await page.locator('[data-testid="search-input"]').fill('Zed');
    await expect(page.locator('[data-testid="search-count"]')).toBeVisible();

    const rows = page.locator('#trackList [data-testid="track-row"]');
    const heads = page.locator('[data-testid^="search-group-"]');
    const stride = await rowStride(page);

    await expect(heads).toHaveCount(2);
    await expect(heads.nth(0)).toHaveAttribute('data-testid', 'search-group-artist');
    await expect(heads.nth(1)).toHaveAttribute('data-testid', 'search-group-album');
    const firstWindow = await rows.count();
    expect(firstWindow).toBeGreaterThan(0);
    expect(firstWindow).toBeLessThanOrEqual(MAX_ROWS);

    // Every rendered section belongs to a non-empty group: the visible artist
    // window paints rows, while the album group sits below the viewport and
    // therefore paints none until it is scrolled to (no empty groups exist).
    const sections = page.locator('#trackList .search-group');
    await expect(sections).toHaveCount(2);
    expect(await sections.nth(0).locator('[data-testid="track-row"]').count()).toBeGreaterThan(0);
    expect(await sections.nth(1).locator('[data-testid="track-row"]').count()).toBe(0);

    // The album head is one group down: it starts below the viewport.
    await expect(heads.first()).toBeInViewport();
    await expect(heads.last()).not.toBeInViewport();
    const albumBox = await heads.last().boundingBox();
    expect(albumBox).not.toBeNull();
    expect(albumBox.y).toBeGreaterThan(await page.evaluate(() => window.innerHeight));

    const last = heads.last();
    await last.evaluate((node) => node.scrollIntoView({ block: 'center' }));
    await frame(page);
    await expect(last).toBeInViewport();
    expect(await rows.count()).toBeLessThanOrEqual(MAX_ROWS);
    // Scrolling to the head is what brings that group's rows in.
    expect(await sections.nth(1).locator('[data-testid="track-row"]').count()).toBeGreaterThan(0);

    // Both group lists keep their full scroll height: 150 artist rows and the
    // 50 album rows that survived the 200-item result cap.
    const lists = page.locator('#trackList .track-list');
    await expect(lists).toHaveCount(2);
    const artistHeight = await lists.nth(0).evaluate((node) => node.offsetHeight);
    const albumHeight = await lists.nth(1).evaluate((node) => node.offsetHeight);
    expect(Math.abs(artistHeight - (150 * stride - 2))).toBeLessThanOrEqual(2 * stride);
    expect(Math.abs(albumHeight - (50 * stride - 2))).toBeLessThanOrEqual(2 * stride);

    const scrollLongTasks = await measurePanelScroll(page);
    console.log(`AJ perf search scroll=${JSON.stringify(scrollLongTasks)}`);
    expect(scrollLongTasks.max).toBeLessThanOrEqual(500);
    expect(scrollLongTasks.p95).toBeLessThanOrEqual(200);
  });
});
