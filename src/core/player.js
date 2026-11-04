/**
 * Thin wrapper around a supplied HTMLAudioElement.
 * The element is injected so this module never creates DOM at import time.
 */

import { t } from '../i18n/index.js';
import { gainFactor } from './gain.js';

async function closeContext(ctx) {
  try {
    if (ctx && typeof ctx.close === 'function') await ctx.close();
  } catch {
    // a context that refuses to close cannot be cleaned up further
  }
}

export class AudioPlayer extends EventTarget {
  #audio;
  #url = null;
  #handlers = [];
  #destroyed = false;
  #createAudioContext;
  #ctx = null;
  #sourceNode = null;
  #gainNode = null;
  #pendingGainDb = null;

  constructor(audio, { createAudioContext } = {}) {
    super();
    if (!audio) throw new Error(t('error.player.noElement'));
    this.#audio = audio;
    this.#createAudioContext =
      typeof createAudioContext === 'function' ? createAudioContext : null;
    this.#audio.preload = 'auto';
    this.#listen('timeupdate', () => {
      this.dispatchEvent(
        new CustomEvent('timeupdate', { detail: { position: this.position, duration: this.duration } }),
      );
    });
    this.#listen('ended', () => this.dispatchEvent(new Event('ended')));
    this.#listen('play', () => this.dispatchEvent(new Event('play')));
    this.#listen('pause', () => this.dispatchEvent(new Event('pause')));
    for (const type of ['waiting', 'stalled', 'suspend']) {
      this.#listen(type, () => this.dispatchEvent(new Event(type)));
    }
    this.#listen('error', () => {
      const error = this.#audio.error ?? new Error(t('error.player.element'));
      this.dispatchEvent(new CustomEvent('error', { detail: { error } }));
    });
  }

  #listen(type, handler) {
    this.#audio.addEventListener(type, handler);
    this.#handlers.push([type, handler]);
  }

  get audio() {
    return this.#audio;
  }

  #revoke() {
    if (this.#url) {
      URL.revokeObjectURL(this.#url);
      this.#url = null;
    }
  }

  /**
   * Point the element at a ready URL synchronously. The caller owns the URL;
   * a previous URL handed to this player is revoked here.
   */
  loadUrl(url) {
    if (this.#destroyed) throw new Error(t('error.player.destroyed'));
    if (typeof url !== 'string' || !url) throw new Error(t('error.player.missingFile'));
    const previous = this.#url;
    this.#audio.src = url;
    this.#url = url;
    if (previous) URL.revokeObjectURL(previous);
  }

  /** Start playback without awaiting it; callers attach their own catch. */
  playNow() {
    if (this.#destroyed) throw new Error(t('error.player.destroyed'));
    if (!this.#audio.src) throw new Error(t('error.player.notLoaded'));
    return this.#audio.play();
  }

  async load(file) {
    if (this.#destroyed) throw new Error(t('error.player.destroyed'));
    if (!file) throw new Error(t('error.player.missingFile'));
    const audio = this.#audio;
    const url = URL.createObjectURL(file);
    this.loadUrl(url);

    const ready = new Promise((resolve, reject) => {
      const cleanup = () => {
        audio.removeEventListener('canplay', onReady);
        audio.removeEventListener('error', onError);
      };
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(audio.error ?? new Error(t('error.player.loadFailed')));
      };
      audio.addEventListener('canplay', onReady);
      audio.addEventListener('error', onError);
    });

    if (typeof audio.load === 'function') audio.load();

    try {
      await ready;
    } catch (error) {
      if (this.#url === url) this.#revoke();
      throw error;
    }
    this.dispatchEvent(new CustomEvent('loaded', { detail: { duration: this.duration } }));
  }

  async play() {
    if (this.#destroyed) throw new Error(t('error.player.destroyed'));
    if (!this.#audio.src) throw new Error(t('error.player.notLoaded'));
    await this.#audio.play();
  }

  pause() {
    this.#audio.pause();
  }

  seek(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value)) return;
    const duration = this.duration;
    const target = Math.max(0, duration > 0 ? Math.min(value, duration) : value);
    try {
      this.#audio.currentTime = target;
    } catch {
      // Element not seekable yet; caller keeps its own position.
    }
  }

  setVolume(value) {
    const volume = Number(value);
    if (!Number.isFinite(volume)) return;
    this.#audio.volume = Math.min(Math.max(volume, 0), 1);
  }

  get position() {
    const time = Number(this.#audio.currentTime);
    return Number.isFinite(time) ? time : 0;
  }

  get duration() {
    const duration = Number(this.#audio.duration);
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
  }

  get playing() {
    return !this.#audio.paused && !this.#audio.ended;
  }

  /**
   * Build the Web Audio graph that applies ReplayGain. Must only build it
   * once the context is running: an element routed into a suspended context
   * goes silent.
   * @returns {Promise<boolean>} whether the graph is ready
   */
  async enableLeveling() {
    if (this.#destroyed) return false;
    if (this.#ctx) {
      try {
        await this.#ctx.resume();
      } catch {
        return false;
      }
      return true;
    }

    const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext ?? null;
    if (!this.#createAudioContext && !Ctor) return false;

    let ctx = null;
    try {
      ctx = this.#createAudioContext ? this.#createAudioContext() : new Ctor();
      if (!ctx) return false;
      await ctx.resume();
      if (ctx.state !== 'running') {
        await closeContext(ctx);
        return false;
      }
      const sourceNode = ctx.createMediaElementSource(this.#audio);
      const gainNode = ctx.createGain();
      sourceNode.connect(gainNode);
      gainNode.connect(ctx.destination);
      this.#ctx = ctx;
      this.#sourceNode = sourceNode;
      this.#gainNode = gainNode;
      if (this.#pendingGainDb !== null) {
        gainNode.gain.value = gainFactor(this.#pendingGainDb);
        this.#pendingGainDb = null;
      }
      return true;
    } catch {
      if (ctx) await closeContext(ctx);
      return false;
    }
  }

  /** Apply a ReplayGain value; remembered until the graph exists. */
  setGain(db) {
    if (this.#gainNode) {
      this.#gainNode.gain.value = gainFactor(db);
      return;
    }
    this.#pendingGainDb = Number.isFinite(db) ? db : null;
  }

  /** Unity gain. Web Audio cannot unwire the route, so it stays connected. */
  disableLeveling() {
    try {
      if (this.#gainNode) this.#gainNode.gain.value = 1;
    } catch {
      // a node that refuses the write is already neutral
    }
  }

  get levelingReady() {
    return this.#gainNode !== null;
  }

  /** True when `playNow()` cannot throw for a missing source. */
  get canHandOffSynchronously() {
    return Boolean(this.#audio.src);
  }

  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    const ctx = this.#ctx;
    this.#ctx = null;
    this.#gainNode = null;
    this.#sourceNode = null;
    if (ctx && typeof ctx.close === 'function') {
      try {
        void ctx.close()?.catch(() => {});
      } catch {
        // ignore
      }
    }
    try {
      this.#audio.pause();
    } catch {
      // ignore
    }
    for (const [type, handler] of this.#handlers) this.#audio.removeEventListener(type, handler);
    this.#handlers = [];
    this.#revoke();
    try {
      this.#audio.removeAttribute('src');
      if (typeof this.#audio.load === 'function') this.#audio.load();
    } catch {
      // ignore
    }
  }
}
