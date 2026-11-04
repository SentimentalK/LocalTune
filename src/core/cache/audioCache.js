/**
 * Audio cache: Cache Storage holds the blobs, IndexedDB holds the LRU index and
 * the offline pins. Pure logic with injectable doubles — no DOM access at
 * import time and no coupling to the store or the player.
 */

export const AUDIO_CACHE_NAME = 'audio-v1';
export const DEFAULT_CACHE_LIMIT = 2 * 1024 ** 3;
export const CACHE_LIMIT_OPTIONS = [
  512 * 1024 ** 2,
  1024 ** 3,
  2 * 1024 ** 3,
  5 * 1024 ** 3,
  0,
];

const AUDIO_PATH = '/__audio/';
const FALLBACK_ORIGIN = 'https://localtune.invalid/';

/** Stable cache key: source plus the path without leading slashes. */
export function cacheKey(source, path) {
  return `${source}:${String(path).replace(/^\/+/, '')}`;
}

/**
 * Synthetic same-origin URL used as the Cache Storage key. It is never
 * fetched; only `caches.match`/`put`/`delete` see it.
 */
export function cacheRequest(key) {
  const base = globalThis.location?.origin ?? FALLBACK_ORIGIN;
  return new Request(new URL(AUDIO_PATH + encodeURIComponent(key), base));
}

/** A pin covers one source's root (`dir === ''`), one path, or a directory. */
export function isPinned(entry, pins) {
  if (!entry) return false;
  const path = String(entry.path ?? '');
  for (const pin of pins ?? []) {
    if (!pin || entry.source !== pin.source) continue;
    const dir = String(pin.dir ?? '');
    if (dir === '') return true;
    if (path === dir || path.startsWith(`${dir}/`)) return true;
  }
  return false;
}

/** Sum of the finite `size` fields. */
export function totalSize(entries) {
  let total = 0;
  for (const entry of entries ?? []) {
    if (Number.isFinite(entry?.size)) total += entry.size;
  }
  return total;
}

/**
 * Keys to evict so the remaining total fits `limitBytes`. Oldest `lastAccess`
 * first (ties by key). Pinned entries are never selected; when everything is
 * pinned and over the limit the result is empty.
 */
export function selectEvictions(entries, limitBytes, pins = []) {
  if (!(limitBytes > 0)) return [];
  const rows = Array.from(entries ?? []);
  const total = totalSize(rows);
  if (total <= limitBytes) return [];

  const ordered = [...rows].sort((a, b) => {
    const left = Number.isFinite(a?.lastAccess) ? a.lastAccess : 0;
    const right = Number.isFinite(b?.lastAccess) ? b.lastAccess : 0;
    if (left !== right) return left - right;
    const aKey = String(a?.key ?? '');
    const bKey = String(b?.key ?? '');
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });

  const evicted = [];
  let remaining = total;
  for (const entry of ordered) {
    if (remaining <= limitBytes) break;
    if (isPinned(entry, pins)) continue;
    evicted.push(entry.key);
    if (Number.isFinite(entry.size)) remaining -= entry.size;
  }
  return evicted;
}

function keyFromRequest(request) {
  const url = typeof request === 'string' ? request : request?.url ?? '';
  const at = url.indexOf(AUDIO_PATH);
  if (at < 0) return null;
  try {
    return decodeURIComponent(url.slice(at + AUDIO_PATH.length));
  } catch {
    return null;
  }
}

export class AudioCache {
  constructor({
    caches = globalThis.caches,
    index,
    pins,
    persist = () => globalThis.navigator?.storage?.persist?.(),
    now = () => Date.now(),
  } = {}) {
    this.caches = caches;
    this.index = index;
    this.pins = pins;
    this.persist = persist;
    this.now = now;
    this._limit = DEFAULT_CACHE_LIMIT;
    this._persistPromise = null;
  }

  get limit() {
    return this._limit;
  }

  set limit(bytes) {
    this._limit = bytes;
  }

  _openCache() {
    if (!this.caches || typeof this.caches.open !== 'function') return null;
    return this.caches.open(AUDIO_CACHE_NAME);
  }

  _ensurePersisted() {
    if (!this._persistPromise) {
      this._persistPromise = Promise.resolve()
        .then(() => this.persist?.())
        .catch(() => {});
    }
    return this._persistPromise;
  }

  async read(key) {
    let cache;
    try {
      cache = await this._openCache();
    } catch {
      return null;
    }
    if (!cache) return null;

    let response;
    try {
      response = await cache.match(cacheRequest(key));
    } catch {
      return null;
    }
    if (!response) return null;

    try {
      const rows = await this.index.all();
      const row = rows.find((item) => item?.key === key);
      if (row) {
        await this.index.put({ ...row, lastAccess: this.now() });
      }
    } catch {
      // The touch is an optimization; the read still succeeded.
    }

    try {
      return await response.blob();
    } catch {
      return null;
    }
  }

  async write({ key, source, path, blob }) {
    await this._ensurePersisted();

    const response = new Response(blob);
    try {
      const cache = await this._openCache();
      if (cache) await cache.put(cacheRequest(key), response);
    } catch {
      // Best effort: the index below still records the intent.
    }

    try {
      await this.index.put({
        key,
        source,
        path,
        size: blob?.size,
        lastAccess: this.now(),
      });
    } catch {
      // Nothing more to do; a later write can retry the row.
    }

    await this.enforceLimit();
  }

  async enforceLimit(limitBytes = this.limit) {
    let rows;
    try {
      rows = await this.index.all();
    } catch {
      return [];
    }

    let pins = [];
    try {
      pins = (await this.pins?.all()) ?? [];
    } catch {
      pins = [];
    }

    const keys = selectEvictions(rows, limitBytes, pins);
    if (!keys.length) return [];

    let cache = null;
    try {
      cache = await this._openCache();
    } catch {
      cache = null;
    }

    for (const key of keys) {
      if (cache) {
        try {
          await cache.delete(cacheRequest(key));
        } catch {
          // Another tab may have removed it already.
        }
      }
      try {
        await this.index.deleteByKeys([key]);
      } catch {
        // Keep evicting the rest.
      }
    }

    return keys;
  }

  async remove(key) {
    let existed = false;

    try {
      const rows = await this.index.all();
      existed = rows.some((row) => row?.key === key);
    } catch {
      existed = false;
    }

    let cache = null;
    try {
      cache = await this._openCache();
    } catch {
      cache = null;
    }
    if (cache) {
      try {
        if (await cache.match(cacheRequest(key))) existed = true;
        await cache.delete(cacheRequest(key));
      } catch {
        // Fall through to the index cleanup.
      }
    }

    try {
      await this.index.deleteByKeys([key]);
    } catch {
      // Nothing else to try.
    }

    return existed;
  }

  async total() {
    try {
      return totalSize(await this.index.all());
    } catch {
      return 0;
    }
  }

  async clear() {
    let rows = [];
    try {
      rows = await this.index.all();
    } catch {
      rows = [];
    }

    const indexed = new Set(rows.map((row) => row?.key).filter((key) => typeof key === 'string'));
    let released = totalSize(rows);

    let cache = null;
    try {
      cache = await this._openCache();
    } catch {
      cache = null;
    }

    if (cache) {
      let requests = [];
      try {
        requests = await cache.keys();
      } catch {
        requests = [];
      }

      for (const request of requests) {
        const key = keyFromRequest(request);
        if (key === null || !indexed.has(key)) {
          try {
            const response = await cache.match(request);
            const size = (await response?.blob())?.size;
            if (Number.isFinite(size)) released += size;
          } catch {
            // Unreadable entry: its bytes stay unaccounted for.
          }
        }
        try {
          await cache.delete(request);
        } catch {
          // Another tab may have removed it already.
        }
      }
    }

    try {
      await this.index.clear();
    } catch {
      // Already empty or unavailable.
    }

    return released;
  }
}
