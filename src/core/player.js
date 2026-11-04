/**
 * Thin wrapper around a supplied HTMLAudioElement.
 * The element is injected so this module never creates DOM at import time.
 */

export class AudioPlayer extends EventTarget {
  #audio;
  #url = null;
  #handlers = [];
  #destroyed = false;

  constructor(audio) {
    super();
    if (!audio) throw new Error('AudioPlayer 需要 HTMLAudioElement');
    this.#audio = audio;
    this.#listen('timeupdate', () => {
      this.dispatchEvent(
        new CustomEvent('timeupdate', { detail: { position: this.position, duration: this.duration } }),
      );
    });
    this.#listen('ended', () => this.dispatchEvent(new Event('ended')));
    this.#listen('play', () => this.dispatchEvent(new Event('play')));
    this.#listen('pause', () => this.dispatchEvent(new Event('pause')));
    this.#listen('error', () => {
      const error = this.#audio.error ?? new Error('音频元素报错');
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

  async load(file) {
    if (this.#destroyed) throw new Error('播放器已销毁');
    if (!file) throw new Error('缺少音频文件');
    const audio = this.#audio;
    const url = URL.createObjectURL(file);

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
        reject(audio.error ?? new Error('音频加载失败'));
      };
      audio.addEventListener('canplay', onReady);
      audio.addEventListener('error', onError);
    });

    audio.src = url;
    this.#revoke();
    this.#url = url;
    if (typeof audio.load === 'function') audio.load();

    try {
      await ready;
    } catch (error) {
      this.#revoke();
      throw error;
    }
    this.dispatchEvent(new CustomEvent('loaded', { detail: { duration: this.duration } }));
  }

  async play() {
    if (this.#destroyed) throw new Error('播放器已销毁');
    if (!this.#audio.src) throw new Error('尚未加载音频');
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

  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
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
