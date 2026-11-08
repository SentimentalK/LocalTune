/**
 * Author-playlist source. Reads the same-origin MP3s under `dist/author/` and
 * keeps them in the shared audio cache, so a played track stays available
 * offline and a re-visit costs no network.
 *
 * Nothing here runs until the author tab imports the manifest and a track is
 * played; `warm()` is the only eager path and the store calls it after the
 * first successful author playback.
 */

import { cacheKey } from '../../cache/audioCache.js';

function cleanPath(path) {
  return String(path ?? '')
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    .join('/');
}

export class AuthorSource {
  kind = 'author';
  trackSource = 'author';
  cacheWholeFiles = true;
  name = '';

  constructor({
    fetchImpl = (...args) => globalThis.fetch(...args),
    cache = null,
    baseUrl = globalThis.location?.href ?? 'http://localhost/',
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.cache = cache;
    this.baseUrl = baseUrl;
    this._inflight = new Map();
  }

  permission() {
    return 'granted';
  }

  configured() {
    return true;
  }

  url(path) {
    return new URL(`./author/${cleanPath(path)}`, this.baseUrl);
  }

  /** Cached blob first, then one network read that fills the cache. */
  async getFile(path) {
    const clean = cleanPath(path);
    const key = cacheKey('author', clean);
    const cached = await this.cache?.read?.(key);
    if (cached) return cached;
    const pending = this._inflight.get(key);
    if (pending) return pending;

    const load = (async () => {
      const response = await this.fetchImpl(this.url(clean));
      if (!response?.ok) {
        const error = new Error(`author track ${clean} failed (${response?.status ?? 'network'})`);
        error.status = response?.status ?? 0;
        throw error;
      }
      const blob = await response.blob();
      if (this.cache?.write) {
        void this.cache.write({ key, source: 'author', path: clean, blob }).catch(() => {});
      }
      return blob;
    })();
    this._inflight.set(key, load);
    try {
      return await load;
    } finally {
      this._inflight.delete(key);
    }
  }

  async open(path) {
    return { file: await this.getFile(path) };
  }

  /**
   * Fill the cache for every track except the one that is already playing.
   * Sequential on purpose: seven 4 MB reads must not race the current track's
   * own decode, and failures stay per-track.
   */
  async warm(tracks, excludeId = null) {
    for (const track of tracks ?? []) {
      if (track?.source !== 'author' || track.id === excludeId) continue;
      try {
        await this.getFile(track.path);
      } catch {
        // One dead track must not stop the rest of the warm pass.
      }
    }
  }
}
