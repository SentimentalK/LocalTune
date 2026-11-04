/**
 * One-slot prefetcher: resolves the next track to a playable Blob URL so an
 * auto-advance can call `HTMLMediaElement.play()` without awaiting a file
 * read first. URL ownership moves to the consumer on `take()`, so the caller
 * revokes it; every other path revokes internally.
 *
 * States: `idle` → `priming` → `ready` → `taken`, or `cleared` at any point.
 */

export class Prefetcher {
  #status = 'idle';
  #id = null;
  #url = null;
  #token = 0;
  #load;
  #createUrl;
  #revokeUrl;

  constructor({
    load,
    createUrl = (blob) => URL.createObjectURL(blob),
    revokeUrl = (url) => URL.revokeObjectURL(url),
  } = {}) {
    this.#load = load;
    this.#createUrl = createUrl;
    this.#revokeUrl = revokeUrl;
  }

  /** Snapshot without the Blob itself. */
  get state() {
    return { status: this.#status, id: this.#id, url: this.#url };
  }

  /**
   * Resolve `track` into a ready URL. Returns `{id, url}` when ready, or null
   * when there is nothing to prefetch, the load failed, or a newer request
   * superseded this one.
   */
  async prime(track) {
    const id = track?.id ?? null;
    if (id == null) {
      this.clear();
      return null;
    }
    if ((this.#status === 'ready' || this.#status === 'priming') && this.#id === id) {
      return this.#status === 'ready' ? { id: this.#id, url: this.#url } : null;
    }

    this.#token += 1;
    const token = this.#token;
    this.#status = 'priming';
    this.#id = id;

    try {
      const blob = await this.#load(track);
      const url = this.#createUrl(blob);
      if (token !== this.#token) {
        // Another prime() or clear() replaced this request while it was loading.
        this.#revokeUrl(url);
        return null;
      }
      const previous = this.#url;
      this.#url = url;
      this.#status = 'ready';
      if (previous) this.#revokeUrl(previous);
      return { id, url };
    } catch {
      if (token === this.#token) {
        const stale = this.#url;
        this.#url = null;
        this.#id = null;
        this.#status = 'idle';
        if (stale) this.#revokeUrl(stale);
      }
      return null;
    }
  }

  /** Hand the ready URL to the caller, or null when the id does not match. */
  take(id) {
    if (this.#status !== 'ready' || this.#id !== id) return null;
    const value = { id: this.#id, url: this.#url };
    this.#url = null;
    this.#id = null;
    this.#status = 'taken';
    return value;
  }

  /** Drop the slot; an untaken URL is revoked. */
  clear() {
    this.#token += 1;
    const url = this.#url;
    this.#url = null;
    this.#id = null;
    this.#status = 'cleared';
    if (url) this.#revokeUrl(url);
  }
}
