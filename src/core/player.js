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

/**
 * Master-scanned compressor settings for in-track levelling. Q is fixed by the
 * node defaults; every other parameter is set explicitly so a future browser
 * default cannot change the sound.
 */
export const LEVELING_COMPRESSOR = {
  threshold: -24,
  knee: 6,
  ratio: 5,
  attack: 0.003,
  release: 0.25,
};

export class AudioPlayer extends EventTarget {
  #audio;
  #url = null;
  #handlers = [];
  #destroyed = false;
  #createAudioContext;
  #createElement;
  #ctx = null;
  #sourceNode = null;
  #gainNode = null;
  #compressorNode = null;
  #pendingGainDb = null;
  #wired = null;

  constructor(audio, { createAudioContext, createElement } = {}) {
    super();
    if (!audio) throw new Error(t('error.player.noElement'));
    this.#audio = audio;
    this.#createAudioContext =
      typeof createAudioContext === 'function' ? createAudioContext : null;
    this.#createElement = typeof createElement === 'function' ? createElement : null;
    this.#audio.preload = 'auto';
    this.#listen('timeupdate', () => {
      this.dispatchEvent(
        new CustomEvent('timeupdate', { detail: { position: this.position, duration: this.duration } }),
      );
    });
    for (const type of ['loadedmetadata', 'durationchange']) {
      this.#listen(type, () => {
        this.dispatchEvent(
          new CustomEvent('durationchange', { detail: { duration: this.duration } }),
        );
      });
    }
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

  /** Stop playback and release the element's source so nothing keeps playing. */
  unload() {
    try {
      this.#audio.pause();
    } catch {
      // The element may already be detached.
    }
    try {
      this.#audio.removeAttribute('src');
      this.#audio.load?.();
    } catch {
      // A missing `load` only skips the readyState reset.
    }
    this.#revoke();
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
   * Route gain → [compressor] → destination. A compressor that was bypassed
   * must be unlinked first: an untouched node keeps its old edges.
   */
  #wire(compressed) {
    const gain = this.#gainNode;
    const ctx = this.#ctx;
    if (!gain || !ctx) {
      this.#wired = null;
      return;
    }
    try {
      gain.disconnect();
    } catch {
      // a node that was never connected has nothing to break
    }
    if (compressed && this.#compressorNode) {
      try {
        this.#compressorNode.disconnect();
      } catch {
        // same: nothing wired yet
      }
      gain.connect(this.#compressorNode);
      this.#compressorNode.connect(ctx.destination);
      this.#wired = 'full';
    } else {
      gain.connect(ctx.destination);
      this.#wired = compressed ? 'gain-only' : 'bypass';
    }
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
      if (this.#ctx.state !== 'running') return false;
      this.#wire(true);
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
      let compressorNode = null;
      try {
        compressorNode = ctx.createDynamicsCompressor();
        for (const [key, value] of Object.entries(LEVELING_COMPRESSOR)) {
          compressorNode[key].value = value;
        }
      } catch {
        compressorNode = null;
      }
      sourceNode.connect(gainNode);
      this.#ctx = ctx;
      this.#sourceNode = sourceNode;
      this.#gainNode = gainNode;
      this.#compressorNode = compressorNode;
      this.#wire(true);
      if (this.#pendingGainDb !== null) {
        gainNode.gain.value = gainFactor(this.#pendingGainDb);
        this.#pendingGainDb = null;
      }
      return true;
    } catch {
      if (ctx) await closeContext(ctx);
      this.#compressorNode = null;
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

  /** Unity gain with the compressor out of the path; the context stays alive. */
  disableLeveling() {
    try {
      if (this.#gainNode) this.#gainNode.gain.value = 1;
    } catch {
      // a node that refuses the write is already neutral
    }
    this.#wire(false);
  }

  get levelingReady() {
    return this.#gainNode !== null;
  }

  /**
   * The Web Audio context once levelling has built the graph, or null. The
   * scratch sound reuses it so the effect lands on the same destination.
   */
  get context() {
    return this.#ctx;
  }

  /** @returns {'full'|'gain-only'|'off'} */
  get levelingMode() {
    if (this.#wired === 'full') return 'full';
    if (this.#wired === 'gain-only') return 'gain-only';
    return 'off';
  }

  /**
   * Drop the graph and replace the media element. A MediaElementSource can
   * never be un-wired, and a cross-origin element routed into a graph goes
   * silent, so streaming playback needs a brand-new element.
   * @returns {Promise<boolean>} whether the element was swapped
   */
  async detachGraph() {
    if (!this.#gainNode && !this.#ctx) return false;
    if (!this.#createElement) return false;
    const ctx = this.#ctx;
    this.#ctx = null;
    this.#gainNode = null;
    this.#compressorNode = null;
    this.#sourceNode = null;
    this.#wired = null;
    this.#pendingGainDb = null;
    const swapped = this.#swapElement();
    if (ctx && typeof ctx.close === 'function') {
      try {
        void ctx.close();
      } catch {
        // a context that refuses to close cannot be cleaned up further
      }
    }
    return swapped;
  }

  #swapElement() {
    const previous = this.#audio;
    let next;
    try {
      next = this.#createElement();
    } catch {
      return false;
    }
    if (!next) return false;
    next.setAttribute('aria-hidden', 'true');
    next.preload = 'auto';
    try {
      next.volume = previous.volume;
    } catch {
      // a fake element may refuse the property
    }
    try {
      next.muted = previous.muted;
    } catch {
      // same
    }
    for (const [type, handler] of this.#handlers) next.addEventListener(type, handler);
    try {
      previous.pause();
    } catch {
      // already paused
    }
    try {
      if (previous !== next && typeof previous.remove === 'function') previous.remove();
    } catch {
      // the old element may already be detached
    }
    this.#audio = next;
    this.dispatchEvent(new CustomEvent('elementchange', { detail: { audio: next } }));
    return true;
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
    this.#compressorNode = null;
    this.#sourceNode = null;
    this.#wired = null;
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
