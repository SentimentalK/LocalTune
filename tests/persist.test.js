import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CACHE_LIMIT_VALUES,
  DEFAULT_CACHE_LIMIT_BYTES,
  loadSettings,
  saveSettings,
} from '../src/core/persist.js';
import { CACHE_LIMIT_OPTIONS, DEFAULT_CACHE_LIMIT } from '../src/core/cache/audioCache.js';

const SETTINGS_KEY = 'settings';
const DEFAULT_LIMIT = 2 * 1024 ** 3;

// Just enough of the `meta` store contract for persist.js: transaction →
// objectStore → get/put, with the completion event on a later microtask.
function createDb(initial = {}) {
  const rows = new Map();
  for (const [key, value] of Object.entries(initial)) rows.set(key, { key, value });

  const db = {
    transaction(name, mode) {
      assert.equal(name, 'meta');
      assert.ok(mode === 'readonly' || mode === 'readwrite');
      const tx = { oncomplete: null, onerror: null, onabort: null };
      tx.objectStore = () => ({
        get(key) {
          const request = { result: rows.get(key) };
          queueMicrotask(() => request.onsuccess?.());
          return request;
        },
        put(row) {
          rows.set(row.key, { key: row.key, value: structuredClone(row.value) });
          queueMicrotask(() => tx.oncomplete?.());
        },
      });
      return tx;
    },
  };

  return { db, rows };
}

function storedSettings(rows) {
  return rows.get(SETTINGS_KEY)?.value;
}

test('the cache limit re-exports the cache module constants', () => {
  assert.equal(DEFAULT_CACHE_LIMIT_BYTES, DEFAULT_CACHE_LIMIT);
  assert.equal(DEFAULT_CACHE_LIMIT_BYTES, DEFAULT_LIMIT);
  assert.deepEqual(CACHE_LIMIT_VALUES, CACHE_LIMIT_OPTIONS);
  assert.deepEqual(CACHE_LIMIT_VALUES, [512 * 1024 ** 2, 1024 ** 3, 2 * 1024 ** 3, 5 * 1024 ** 3, 0]);
});

test('loadSettings defaults a missing cache limit to 2 GiB', async () => {
  const { db } = createDb();

  assert.deepEqual(await loadSettings(db), {
    language: 'auto',
    cacheLimitBytes: DEFAULT_LIMIT,
    youtubeApiKey: '',
    playlistProxyUrl: '',
  });
});

test('every allowed cache limit survives a save/load round trip', async () => {
  for (const bytes of CACHE_LIMIT_VALUES) {
    const { db, rows } = createDb();
    await saveSettings(db, { language: 'ja', cacheLimitBytes: bytes });

    assert.deepEqual(storedSettings(rows), {
      language: 'ja',
      cacheLimitBytes: bytes,
      youtubeApiKey: '',
      playlistProxyUrl: '',
    });
    assert.deepEqual(await loadSettings(db), {
      language: 'ja',
      cacheLimitBytes: bytes,
      youtubeApiKey: '',
      playlistProxyUrl: '',
    });
  }
});

test('an invalid cache limit falls back to 2 GiB on load and on save', async () => {
  const invalid = [null, undefined, -1, 1024, 3 * 1024 ** 3, '1073741824', Number.NaN, Infinity];

  for (const bytes of invalid) {
    const { db, rows } = createDb();
    await saveSettings(db, { language: 'zh-CN', cacheLimitBytes: bytes });

    assert.deepEqual(storedSettings(rows), {
      language: 'zh-CN',
      cacheLimitBytes: DEFAULT_LIMIT,
      youtubeApiKey: '',
      playlistProxyUrl: '',
    });
    assert.equal((await loadSettings(db)).cacheLimitBytes, DEFAULT_LIMIT);
  }

  for (const bytes of invalid) {
    const { db } = createDb({ [SETTINGS_KEY]: { language: 'en', cacheLimitBytes: bytes } });
    assert.deepEqual(await loadSettings(db), {
      language: 'en',
      cacheLimitBytes: DEFAULT_LIMIT,
      youtubeApiKey: '',
      playlistProxyUrl: '',
    });
  }
});

test('the language field keeps its old validation next to the cache limit', async () => {
  const { db } = createDb();
  await saveSettings(db, { language: 'klingon', cacheLimitBytes: 0 });
  assert.deepEqual(await loadSettings(db), {
    language: 'auto',
    cacheLimitBytes: 0,
    youtubeApiKey: '',
    playlistProxyUrl: '',
  });

  await saveSettings(db, { language: 'zh-TW', cacheLimitBytes: 512 * 1024 ** 2 });
  assert.deepEqual(await loadSettings(db), {
    language: 'zh-TW',
    cacheLimitBytes: 512 * 1024 ** 2,
    youtubeApiKey: '',
    playlistProxyUrl: '',
  });
});

test('the playlist settings default to empty strings', async () => {
  const { db } = createDb();

  const settings = await loadSettings(db);
  assert.equal(settings.youtubeApiKey, '');
  assert.equal(settings.playlistProxyUrl, '');
});

test('the YouTube key and playlist proxy survive a save/load round trip', async () => {
  const { db, rows } = createDb();
  const settings = {
    language: 'en',
    cacheLimitBytes: DEFAULT_LIMIT,
    youtubeApiKey: '  AIzaSyExample  ',
    playlistProxyUrl: '  https://proxy.example.com/playlist  ',
  };

  const saved = await saveSettings(db, settings);
  assert.deepEqual(saved, {
    language: 'en',
    cacheLimitBytes: DEFAULT_LIMIT,
    youtubeApiKey: 'AIzaSyExample',
    playlistProxyUrl: 'https://proxy.example.com/playlist',
  });
  assert.deepEqual(storedSettings(rows), saved);
  assert.deepEqual(await loadSettings(db), saved);
});

test('the playlist proxy keeps a same-origin path', async () => {
  const { db } = createDb();

  const saved = await saveSettings(db, { playlistProxyUrl: '  /api/resolve  ' });
  assert.equal(saved.playlistProxyUrl, '/api/resolve');
  assert.equal((await loadSettings(db)).playlistProxyUrl, '/api/resolve');
});

test('the playlist proxy rejects protocol-relative and non-HTTPS values', async () => {
  const { db } = createDb();

  const saved = await saveSettings(db, { playlistProxyUrl: '//evil.example/x' });
  assert.equal(saved.playlistProxyUrl, '');
  assert.equal((await loadSettings(db)).playlistProxyUrl, '');
});

test('the YouTube key and playlist proxy are cleaned when invalid', async () => {
  const { db } = createDb();
  const cleaned = {
    language: 'auto',
    cacheLimitBytes: DEFAULT_LIMIT,
    youtubeApiKey: '',
    playlistProxyUrl: '',
  };

  await saveSettings(db, {
    youtubeApiKey: 42,
    playlistProxyUrl: 'http://proxy.example.com/playlist',
  });
  assert.deepEqual(await loadSettings(db), cleaned);

  await saveSettings(db, {
    youtubeApiKey: 'k'.repeat(201),
    playlistProxyUrl: `https://proxy.example.com/${'p'.repeat(300)}`,
  });
  assert.deepEqual(await loadSettings(db), cleaned);

  const { db: seeded } = createDb({
    [SETTINGS_KEY]: {
      youtubeApiKey: { key: 'not a string' },
      playlistProxyUrl: 'ftp://proxy.example.com/playlist',
    },
  });
  assert.deepEqual(await loadSettings(seeded), cleaned);
});
