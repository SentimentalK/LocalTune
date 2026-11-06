import { expect, test } from '@playwright/test';

/**
 * Create a v5 database (inline `cover` Blobs) before the app starts. Writes
 * happen inside the versionchange transaction, so they are committed before the
 * app's own open can upgrade the schema. A second navigation opens the already
 * upgraded DB with a stale version: that error is expected and swallowed.
 */
async function seedInlineCovers(page, tracks) {
  await page.addInitScript((seed) => {
    const bytes = (size, fill) => {
      const buffer = new Uint8Array(size);
      buffer.fill(fill);
      return buffer;
    };
    try {
      const request = indexedDB.open('localtune', 5);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('tracks')) {
          const store = db.createObjectStore('tracks', { keyPath: 'id' });
          store.createIndex('album', 'album', { unique: false });
          store.createIndex('artist', 'artist', { unique: false });
        }
        const specs = {
          meta: { keyPath: 'key' },
          cacheIndex: { keyPath: 'key' },
          playlog: { keyPath: 'id', autoIncrement: true },
          opfsIndex: { keyPath: 'path' },
          playlists: { keyPath: 'id' },
          stats: { keyPath: 'id' },
        };
        for (const [name, options] of Object.entries(specs)) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, options);
        }
        const tx = request.transaction;
        const rows = tx.objectStore('tracks');
        seed.forEach((track, index) => {
          rows.put({
            id: `fsa:${track.path}`,
            path: track.path,
            title: `Track ${index + 1}`,
            artist: 'Seed',
            album: 'Seed album',
            year: 2000,
            trackNo: index + 1,
            duration: 60,
            mtime: 1_700_000_000_000,
            size: 4096,
            cover: new Blob([bytes(track.size, 40 + index)], { type: track.type }),
            source: 'fsa',
            externalIds: {},
          });
        });
        tx.objectStore('meta').put({ key: 'demoDismissed', value: true });
      };
      request.onsuccess = () => request.result.close();
      request.onerror = () => {};
    } catch {
      // A DB already at v6 raises VersionError asynchronously; ignore it.
    }
  }, tracks);
}

/** Create a v6 database with covers already split into their own store. */
async function seedSplitCovers(page, tracks) {
  await page.addInitScript((seed) => {
    const bytes = (size, fill) => {
      const buffer = new Uint8Array(size);
      buffer.fill(fill);
      return buffer;
    };
    try {
      const request = indexedDB.open('localtune', 6);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('tracks')) {
          const store = db.createObjectStore('tracks', { keyPath: 'id' });
          store.createIndex('album', 'album', { unique: false });
          store.createIndex('artist', 'artist', { unique: false });
        }
        const specs = {
          covers: { keyPath: 'id' },
          meta: { keyPath: 'key' },
          cacheIndex: { keyPath: 'key' },
          playlog: { keyPath: 'id', autoIncrement: true },
          opfsIndex: { keyPath: 'path' },
          playlists: { keyPath: 'id' },
          stats: { keyPath: 'id' },
        };
        for (const [name, options] of Object.entries(specs)) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, options);
        }
        const tx = request.transaction;
        const rows = tx.objectStore('tracks');
        const covers = tx.objectStore('covers');
        seed.forEach((track, index) => {
          const id = `fsa:${track.path}`;
          const cover = new Blob([bytes(track.size, 60 + (index % 100))], { type: track.type });
          rows.put({
            id,
            path: track.path,
            title: `Track ${index + 1}`,
            artist: 'Seed',
            album: 'Seed album',
            year: 2000,
            trackNo: index + 1,
            duration: 60,
            mtime: 1_700_000_000_000,
            size: 4096,
            hasCover: true,
            coverSize: track.size,
            coverType: track.type,
            source: 'fsa',
            externalIds: {},
          });
          covers.put({ id, cover });
        });
        tx.objectStore('meta').put({ key: 'demoDismissed', value: true });
      };
      request.onsuccess = () => request.result.close();
      request.onerror = () => {};
    } catch {
      // Already seeded by an earlier navigation.
    }
  }, tracks);
}

/**
 * A v6 row with a stored cover plus a real (tiny) MP3 whose mtime/size differ
 * from the row. A rescan re-reads the file through the enrich path and writes
 * the row back; the covers store must survive that write.
 */
async function seedRereadCase(page) {
  await page.addInitScript(() => {
    // Force the <input webkitdirectory> source so the seeded fileList is the
    // granted library; desktop Chromium otherwise prefers showDirectoryPicker.
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: undefined,
    });
    const text = 'Retitled';
    const contentSize = 1 + text.length;
    const frame = new Uint8Array(10 + contentSize);
    frame.set([0x54, 0x49, 0x54, 0x32]); // TIT2
    frame[4] = 0;
    frame[5] = 0;
    frame[6] = (contentSize >> 8) & 0xff;
    frame[7] = contentSize & 0xff;
    frame[10] = 0; // latin1
    for (let i = 0; i < text.length; i += 1) frame[11 + i] = text.charCodeAt(i);
    const tagSize = frame.length;
    const header = new Uint8Array(10);
    header.set([0x49, 0x44, 0x33, 3, 0, 0]); // ID3v2.3
    header[6] = (tagSize >> 21) & 0x7f;
    header[7] = (tagSize >> 14) & 0x7f;
    header[8] = (tagSize >> 7) & 0x7f;
    header[9] = tagSize & 0x7f;
    const bytes = new Uint8Array(10 + tagSize + 4);
    bytes.set(header);
    bytes.set(frame, 10);
    bytes.set([0xff, 0xfb, 0x90, 0x00], 10 + tagSize);
    const file = new File([bytes], 'a.mp3', { type: 'audio/mpeg', lastModified: 1_700_000_000_000 });

    try {
      const request = indexedDB.open('localtune', 6);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('tracks')) {
          const store = db.createObjectStore('tracks', { keyPath: 'id' });
          store.createIndex('album', 'album', { unique: false });
          store.createIndex('artist', 'artist', { unique: false });
        }
        const specs = {
          covers: { keyPath: 'id' },
          meta: { keyPath: 'key' },
          cacheIndex: { keyPath: 'key' },
          playlog: { keyPath: 'id', autoIncrement: true },
          opfsIndex: { keyPath: 'path' },
          playlists: { keyPath: 'id' },
          stats: { keyPath: 'id' },
        };
        for (const [name, options] of Object.entries(specs)) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, options);
        }
        const tx = request.transaction;
        const id = 'fsa:Music/a.mp3';
        tx.objectStore('tracks').put({
          id,
          path: 'Music/a.mp3',
          title: 'Track 1',
          artist: '',
          album: '',
          year: null,
          trackNo: null,
          duration: 0,
          mtime: 1,
          size: 1,
          hasCover: true,
          coverSize: 777,
          coverType: 'image/png',
          source: 'fsa',
          externalIds: {},
        });
        tx.objectStore('covers').put({
          id,
          cover: new Blob([new Uint8Array(777).fill(7)], { type: 'image/png' }),
        });
        tx.objectStore('meta').put({ key: 'fileList', value: [{ path: 'Music/a.mp3', file }] });
        tx.objectStore('meta').put({ key: 'localMode', value: 'reference' });
        tx.objectStore('meta').put({ key: 'demoDismissed', value: true });
        tx.objectStore('meta').put({ key: 'lastTagParserVersion', value: 2 });
      };
      request.onsuccess = () => request.result.close();
      request.onerror = () => {};
    } catch {
      // Already seeded by an earlier navigation.
    }
  });
}

async function readStores(page, names) {
  return page.evaluate(async (storeNames) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('localtune');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const readAll = (name) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(name, 'readonly');
        const request = tx.objectStore(name).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const result = {};
    for (const name of storeNames) {
      const rows = await readAll(name);
      // Playwright cannot serialise a Blob across the bridge; flatten it.
      result[name] = rows.map((row) => {
        if (row?.cover instanceof Blob) {
          return { id: row.id, cover: { size: row.cover.size, type: row.cover.type } };
        }
        return row;
      });
    }
    db.close();
    return result;
  }, names);
}

test('v5 inline covers migrate into the covers store byte for byte', async ({ page }) => {
  const seeded = [
    { path: 'Music/a.mp3', size: 1024, type: 'image/png' },
    { path: 'Music/b.mp3', size: 2048, type: 'image/jpeg' },
  ];
  await seedInlineCovers(page, seeded);

  await page.goto('/');
  await expect(page.locator('.deck')).toBeVisible();
  await expect(page.locator('#status')).toBeHidden({ timeout: 10_000 });

  const { tracks, covers } = await readStores(page, ['tracks', 'covers']);

  expect(tracks).toHaveLength(seeded.length);
  for (const row of tracks) {
    expect(Object.prototype.hasOwnProperty.call(row, 'cover')).toBe(false);
    expect(row.hasCover).toBe(true);
    expect(row.coverSize).toBeGreaterThan(0);
  }
  const byPath = new Map(tracks.map((row) => [row.path, row]));
  expect(byPath.get('Music/a.mp3')?.coverSize).toBe(1024);
  expect(byPath.get('Music/b.mp3')?.coverSize).toBe(2048);

  expect(covers).toHaveLength(seeded.length);
  const sizes = Object.fromEntries(
    covers.map((row) => [row.id.replace(/^fsa:/, ''), row.cover?.size]),
  );
  expect(sizes).toEqual({ 'Music/a.mp3': 1024, 'Music/b.mp3': 2048 });
  const types = Object.fromEntries(
    covers.map((row) => [row.id.replace(/^fsa:/, ''), row.cover?.type]),
  );
  expect(types).toEqual({ 'Music/a.mp3': 'image/png', 'Music/b.mp3': 'image/jpeg' });

  // The stage resolves the current track's cover on demand.
  await expect(page.locator('#cover')).toHaveAttribute('src', /^blob:/);

  await page.locator('[data-testid="folder-source-local"]').click();
  await page.locator('[data-testid="folder-dir-Music"]').click();
  await expect(page.locator('#trackList img.track-cover[src^="blob:"]').first()).toBeVisible();
});

test('a large library loads cover URLs only for rendered rows and keeps all cover data', async ({
  page,
}) => {
  const seeded = Array.from({ length: 60 }, (_, index) => ({
    path: `Music/track-${String(index + 1).padStart(2, '0')}.mp3`,
    size: 1024,
    type: 'image/png',
  }));
  await seedSplitCovers(page, seeded);

  await page.goto('/');
  await expect(page.locator('.deck')).toBeVisible();
  await expect(page.locator('#status')).toBeHidden({ timeout: 10_000 });

  await page.locator('[data-testid="folder-source-local"]').click();
  await page.locator('[data-testid="folder-dir-Music"]').click();

  const rows = page.locator('#trackList [data-testid="track-row"]');
  const rendered = await rows.count();
  expect(rendered).toBeGreaterThan(0);
  expect(rendered).toBeLessThanOrEqual(60);

  const covers = page.locator('#trackList img.track-cover[src^="blob:"]');
  await expect(covers.first()).toBeVisible();
  const loaded = await covers.count();
  expect(loaded).toBeGreaterThan(0);
  expect(loaded).toBeLessThanOrEqual(await rows.count());

  const { covers: stored } = await readStores(page, ['covers']);
  expect(stored).toHaveLength(60);
  expect(stored.every((row) => row.cover?.size === 1024)).toBe(true);
});

test('a rescan tag re-read keeps the stored cover', async ({ page }) => {
  await seedRereadCase(page);

  await page.goto('/');
  await expect(page.locator('.deck')).toBeVisible();
  await expect(page.locator('#status')).toBeHidden({ timeout: 10_000 });

  // The listing differs from the file, so rescan queues an enrich read.
  await page.locator('[data-testid="settings-open"]').click();
  await page.locator('[data-testid="settings-sync-local"]').click();
  await expect
    .poll(
      async () => {
        const { tracks } = await readStores(page, ['tracks']);
        return tracks[0]?.title;
      },
      { timeout: 10_000 },
    )
    .toBe('Retitled');

  const { tracks, covers } = await readStores(page, ['tracks', 'covers']);
  expect(tracks[0].hasCover).toBe(true);
  expect(tracks[0].coverSize).toBe(777);
  expect(covers).toHaveLength(1);
  expect(covers[0].id).toBe('fsa:Music/a.mp3');
  expect(covers[0].cover.size).toBe(777);
  expect(covers[0].cover.type).toBe('image/png');
});
