/**
 * Application store: the single entry point for the UI.
 * Owns the library, the queue, the audio element and persistence, and emits
 * a 'change' event whenever the read-only state snapshot is updated.
 */

import { openDb, putTracks, deleteTracksById, getAllTracks, getMeta, setMeta } from './db.js';
import { createSource } from './source.js';
import { readMetadata, describeTags } from './metadata/index.js';
import { formatTagReport } from './metadata/diagnostics.js';
import { estimateLibrary, estimateAudioCache, clearAudioCache as clearCachedAudio } from './storage.js';
import { isGarbledTrack } from './metadata/garbled.js';
import { BUILD_VERSION } from './version.js';
import { migrateGarbledTracks } from './migrate.js';
import { diffScan } from './scan.js';
import {
  createQueue,
  setQueue,
  currentTrack,
  advance,
  back,
  toggleShuffle as toggleShuffleState,
  cycleRepeat as cycleRepeatState,
  removeAt as removeAtState,
} from './queue.js';
import { AudioPlayer } from './player.js';
import { loadPlayback, savePlayback, loadSettings, saveSettings } from './persist.js';
import { installMediaSession, syncMediaSession } from './mediaSession.js';
import { t } from '../i18n/index.js';

const VIEWS = new Set(['tracks', 'albums', 'artists', 'folders', 'queue', 'settings']);
const MEDIA_SYNC_INTERVAL = 1000;

function sortTracks(tracks) {
  return Array.from(tracks ?? []).sort((a, b) => String(a.path).localeCompare(String(b.path)));
}

function basename(path) {
  const clean = String(path ?? '');
  return clean.slice(clean.lastIndexOf('/') + 1);
}

function fallbackTitle(path) {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function errorMessage(error) {
  if (!error) return t('common.unknownError');
  if (typeof error === 'string') return error;
  return error.message ? String(error.message) : String(error);
}

function buildTrack(entry, meta) {
  const path = entry.path;
  return {
    id: `fsa:${path}`,
    path,
    title: meta.title || fallbackTitle(path),
    artist: meta.artist || '',
    album: meta.album || '',
    year: Number.isFinite(meta.year) ? meta.year : null,
    trackNo: Number.isFinite(meta.trackNo) ? meta.trackNo : null,
    duration: Number.isFinite(meta.duration) && meta.duration > 0 ? meta.duration : 0,
    mtime: Number.isFinite(entry.mtime) ? entry.mtime : entry.file?.lastModified ?? 0,
    size: Number.isFinite(entry.size) ? entry.size : entry.file?.size ?? 0,
    cover: meta.cover ?? null,
    source: 'fsa',
    externalIds: {},
  };
}

export class Store extends EventTarget {
  constructor(db) {
    super();
    this.db = db;
    this.source = createSource(db);
    this.audio = typeof Audio === 'function' ? new Audio() : null;
    this.player = this.audio ? new AudioPlayer(this.audio) : null;
    this.queue = createQueue([]);

    this._scanning = false;
    this._migrating = false;
    this._loading = false;
    this._loadedId = null;
    this._pendingSeek = null;
    this._lastSyncAt = 0;

    this._state = {
      ready: false,
      view: 'tracks',
      tracks: [],
      queue: { tracks: [], index: -1, shuffle: false, repeat: 'off' },
      current: { track: null, playing: false, position: 0, duration: 0, volume: 1 },
      source: {
        kind: this.source.kind,
        connected: false,
        permission: 'none',
        name: '',
        error: null,
        scanning: false,
        progress: { done: 0, total: 0 },
      },
      settings: { language: 'auto' },
      updateReady: false,
      migration: { running: false, done: 0, total: 0, error: null },
    };

    this.#bindPlayer();
  }

  get state() {
    return this._state;
  }

  #bindPlayer() {
    const player = this.player;
    if (!player) return;

    player.addEventListener('timeupdate', (event) => {
      const detail = event.detail ?? {};
      const position = Number(detail.position) || 0;
      const duration = Number(detail.duration) || 0;
      this._state.current.position = position;
      if (duration > 0) this._state.current.duration = duration;
      this._emit();
      this._syncMediaSession();
      this._savePlayback();
    });

    player.addEventListener('loaded', (event) => {
      const duration = Number(event.detail?.duration) || 0;
      this._adoptTrackDuration(duration);
      this._emit();
      this._syncMediaSession(true);
    });

    player.addEventListener('ended', () => {
      void this._handleEnded();
    });

    player.addEventListener('play', () => {
      this._state.current.playing = true;
      this._emit();
      this._syncMediaSession(true);
      this._savePlayback();
    });

    player.addEventListener('pause', () => {
      if (this._loading) return;
      this._state.current.playing = false;
      this._emit();
      this._syncMediaSession(true);
      this._savePlayback();
    });

    player.addEventListener('error', (event) => {
      const error = event.detail?.error ?? new Error(t('error.store.playFailed'));
      this._state.source.error = errorMessage(error);
      this._state.current.playing = false;
      this._emit();
    });
  }

  async init() {
    let permission = 'none';
    try {
      permission = await this.source.restore();
    } catch {
      permission = 'none';
    }

    const tracks = sortTracks(await getAllTracks(this.db).catch(() => []));
    const playback = await loadPlayback(this.db).catch(() => null);
    const settings = await loadSettings(this.db).catch(() => ({
      language: 'auto',
    }));

    this._state.tracks = tracks;
    this._state.settings = { language: 'auto', ...settings };
    this._state.source = {
      ...this._state.source,
      kind: this.source.kind,
      connected: permission !== 'none',
      permission,
      name: this.source.name ?? '',
    };

    const volume = Number.isFinite(playback?.volume) ? playback.volume : 1;
    if (tracks.length) {
      const byId = new Map(tracks.map((track) => [track.id, track]));
      let queueTracks = tracks;
      let startIndex = 0;
      if (playback?.queueIds?.length) {
        const restored = playback.queueIds.map((id) => byId.get(id)).filter(Boolean);
        if (restored.length) {
          queueTracks = restored;
          startIndex = clamp(playback.queueIndex ?? 0, 0, restored.length - 1);
        }
      }
      if (playback?.trackId) {
        const found = queueTracks.findIndex((track) => track.id === playback.trackId);
        if (found >= 0) startIndex = found;
      }
      this.queue = setQueue(
        { ...createQueue([]), shuffle: Boolean(playback?.shuffle), repeat: playback?.repeat ?? 'off' },
        queueTracks,
        startIndex,
      );
      const track = currentTrack(this.queue);
      const savedPosition = Number.isFinite(playback?.position) ? Math.max(playback.position, 0) : 0;
      const position = track?.duration > 0 ? Math.min(savedPosition, track.duration) : savedPosition;
      this._state.current = {
        track,
        playing: false,
        position,
        duration: track?.duration ?? 0,
        volume,
      };
      this._pendingSeek = position > 0 ? position : null;
      this.player?.setVolume(volume);
      this._reflectQueue();
    } else {
      this._state.current = { track: null, playing: false, position: 0, duration: 0, volume };
      this._state.queue = {
        tracks: [],
        index: -1,
        shuffle: this.queue.shuffle,
        repeat: this.queue.repeat,
      };
    }

    this._state.ready = true;
    installMediaSession(this);
    syncMediaSession(this._state);
    this._emit();
    void this._maybeMigrateTags();
  }

  /**
   * Re-read tags for tracks that look garbled, once per build. Runs in the
   * background after init; playback is never awaited on it.
   */
  async _maybeMigrateTags() {
    if (this._migrating) return;
    this._migrating = true;
    try {
      const last = await getMeta(this.db, 'lastBuildVersion').catch(() => null);
      if (last === BUILD_VERSION) return;
      // Without a granted directory there is nothing to read; retry next launch
      // or when the user grants permission in this session.
      if (this.source.permission() !== 'granted') return;

      this._state.migration = {
        running: true,
        done: 0,
        total: this._state.tracks.filter(isGarbledTrack).length,
        error: null,
      };
      this._emit();

      try {
        const { changed } = await migrateGarbledTracks({
          tracks: this._state.tracks,
          getFile: (path) => this.source.getFile(path),
          readMetadata,
          onProgress: ({ done, total }) => {
            this._state.migration = { ...this._state.migration, done, total };
            if (done % 5 === 0 || done === total) this._emit();
          },
        });

        if (changed.length) await putTracks(this.db, changed);
        const byId = new Map(changed.map((track) => [track.id, track]));
        this._state.tracks = sortTracks(
          this._state.tracks.map((track) => byId.get(track.id) ?? track),
        );
        this._reconcileQueue([]);
        await setMeta(this.db, 'lastBuildVersion', BUILD_VERSION);
      } catch (error) {
        this._state.migration = { ...this._state.migration, error: errorMessage(error) };
      } finally {
        this._state.migration = { ...this._state.migration, running: false };
        this._emit();
      }
    } finally {
      this._migrating = false;
    }
  }

  async connectSource() {
    this._state.source = { ...this._state.source, error: null };
    this._emit();
    try {
      await this.source.connect();
      this._state.source = {
        ...this._state.source,
        connected: true,
        permission: this.source.permission(),
        name: this.source.name ?? '',
      };
      this._emit();
      await this.rescan();
      void this._maybeMigrateTags();
    } catch (error) {
      if (error?.name === 'AbortError') return;
      this._state.source = {
        ...this._state.source,
        connected: this.source.permission() !== 'none',
        permission: this.source.permission(),
        name: this.source.name ?? '',
        error: errorMessage(error),
      };
      this._emit();
    }
  }

  async requestSourcePermission() {
    const granted = await this.source.ensurePermission().catch(() => false);
    this._state.source = {
      ...this._state.source,
      connected: this.source.permission() !== 'none',
      permission: this.source.permission(),
      error: null,
    };
    this._emit();
    if (granted) {
      await this.rescan();
      void this._maybeMigrateTags();
    }
    return granted;
  }

  async rescan() {
    if (this._scanning) return;
    this._state.source = { ...this._state.source, error: null };
    this._emit();

    if (this.source.permission() !== 'granted') {
      const granted = await this.source.ensurePermission().catch(() => false);
      if (!granted) {
        this._state.source = {
          ...this._state.source,
          connected: this.source.permission() !== 'none',
          permission: this.source.permission(),
          error:
            this.source.permission() === 'none'
              ? t('error.store.notConnected')
              : t('error.store.permissionRequired'),
        };
        this._emit();
        return;
      }
      this._state.source = { ...this._state.source, permission: 'granted' };
    }

    this._scanning = true;
    this._state.source = {
      ...this._state.source,
      scanning: true,
      error: null,
      progress: { done: 0, total: 0 },
    };
    this._emit();

    try {
      const entries = [];
      for await (const entry of this.source.scan()) {
        entries.push(entry);
        this._state.source = {
          ...this._state.source,
          progress: { done: entries.length, total: 0 },
        };
        if (entries.length % 25 === 0) this._emit();
      }

      const previous = await getAllTracks(this.db).catch(() => this._state.tracks);
      const diff = diffScan(previous, entries);
      const byId = new Map(previous.map((track) => [track.id, track]));

      const pending = [...diff.added, ...diff.updated];
      this._state.source = {
        ...this._state.source,
        progress: { done: 0, total: pending.length },
      };
      this._emit();

      const fresh = [];
      let done = 0;
      for (const entry of pending) {
        const meta = await readMetadata(entry.file);
        const track = buildTrack(entry, meta);
        fresh.push(track);
        byId.set(track.id, track);
        done += 1;
        this._state.source = {
          ...this._state.source,
          progress: { done, total: pending.length },
        };
        if (done % 5 === 0 || done === pending.length) this._emit();
      }

      if (fresh.length) await putTracks(this.db, fresh);
      if (diff.removedIds.length) await deleteTracksById(this.db, diff.removedIds);
      for (const id of diff.removedIds) byId.delete(id);

      this._state.tracks = sortTracks([...byId.values()]);
      await setMeta(this.db, 'lastScan', {
        at: Date.now(),
        added: diff.added.length,
        updated: diff.updated.length,
        removed: diff.removedIds.length,
      });

      this._reconcileQueue(diff.removedIds);
      this._state.source = {
        ...this._state.source,
        scanning: false,
        progress: { done: 0, total: 0 },
      };
      this._emit();
      this._savePlayback();
    } catch (error) {
      this._state.source = {
        ...this._state.source,
        scanning: false,
        progress: { done: 0, total: 0 },
        error: errorMessage(error),
      };
      this._emit();
    } finally {
      this._scanning = false;
    }
  }

  async rescanTags() {
    if (this._scanning) return;
    this._scanning = true;
    const tracks = this._state.tracks;
    this._state.source = {
      ...this._state.source,
      scanning: true,
      progress: { done: 0, total: tracks.length },
    };
    this._emit();

    if (this.source.permission() !== 'granted') {
      const granted = await this.source.ensurePermission().catch(() => false);
      if (!granted) {
        this._state.source = {
          ...this._state.source,
          connected: this.source.permission() !== 'none',
          permission: this.source.permission(),
          scanning: false,
          progress: { done: 0, total: 0 },
          error: t('error.store.permissionRequired'),
        };
        this._scanning = false;
        this._emit();
        return;
      }
      this._state.source = { ...this._state.source, permission: 'granted' };
    }

    try {
      const updated = [];
      const changed = [];
      let done = 0;
      for (const track of tracks) {
        try {
          const file = await this.source.getFile(track.path);
          const meta = await readMetadata(file);
          const hasMeta =
            Boolean(meta.title) ||
            Boolean(meta.artist) ||
            Boolean(meta.album) ||
            meta.year != null ||
            meta.trackNo != null ||
            meta.duration > 0 ||
            Boolean(meta.cover);
          if (hasMeta) {
            const next = buildTrack(
              { path: track.path, file, mtime: track.mtime, size: track.size },
              { ...meta, duration: meta.duration > 0 ? meta.duration : track.duration },
            );
            updated.push(next);
            changed.push(next);
          } else {
            updated.push(track);
          }
        } catch {
          updated.push(track);
        }
        done += 1;
        this._state.source = {
          ...this._state.source,
          progress: { done, total: tracks.length },
        };
        if (done % 25 === 0 || done === tracks.length) this._emit();
      }

      this._state.tracks = updated;
      if (changed.length) await putTracks(this.db, changed);
      this._reconcileQueue([]);
      this._state.source = {
        ...this._state.source,
        scanning: false,
        progress: { done: 0, total: 0 },
      };
      this._emit();
      this._savePlayback();
    } catch (error) {
      this._state.source = {
        ...this._state.source,
        scanning: false,
        progress: { done: 0, total: 0 },
        error: errorMessage(error),
      };
      this._emit();
    } finally {
      this._scanning = false;
    }
  }

  setView(view) {
    if (!VIEWS.has(view)) return;
    this._state.view = view;
    this._emit();
  }

  /** Disconnect the source and forget its grant; indexed tracks stay. */
  async removeSource() {
    await this.source.forget().catch(() => {});
    this._state.source = {
      ...this._state.source,
      connected: false,
      permission: 'none',
      name: '',
      error: null,
    };
    this._emit();
  }

  /** Delete every indexed track, stop playback and persist the empty state. */
  async clearLibrary() {
    const ids = this._state.tracks.map((track) => track.id);
    await deleteTracksById(this.db, ids);
    this.player?.pause();
    this._loadedId = null;
    this._state.tracks = [];
    this.queue = createQueue([]);
    this._reflectQueue();
    this._state.current = {
      ...this._state.current,
      track: null,
      playing: false,
      position: 0,
      duration: 0,
    };
    this._emit();
    this._savePlayback();
  }

  /** Index, cover, cached-audio and browser quota figures for the settings view. */
  async storageEstimate() {
    const { indexBytes, coverBytes } = await estimateLibrary(this._state.tracks);
    const audioBytes = await estimateAudioCache().catch(() => 0);
    let usage = null;
    let quota = null;
    try {
      const estimate = await globalThis.navigator?.storage?.estimate?.();
      if (Number.isFinite(estimate?.usage)) usage = estimate.usage;
      if (Number.isFinite(estimate?.quota)) quota = estimate.quota;
    } catch {
      // Quota is optional; the two library figures still render.
    }
    return { indexBytes, coverBytes, audioBytes, usage, quota };
  }

  /** Drop cached audio responses; returns the bytes released. */
  async clearAudioCache() {
    return clearCachedAudio();
  }

  /** Multi-line tag report for one track; errors are left for the dialog. */
  async describeTrackTags(trackId) {
    const track = this._state.tracks.find((item) => item.id === trackId);
    if (!track) throw new Error(t('error.store.trackMissing'));
    const file = await this.source.getFile(track.path);
    const described = await describeTags(file);
    return formatTagReport(described);
  }

  async playTrack(trackId) {
    const tracks = this._state.tracks;
    if (!tracks.some((track) => track.id === trackId)) return;
    await this.playQueue(tracks, trackId);
  }

  async playQueue(tracks, startId) {
    const list = Array.from(tracks ?? []);
    if (!list.length) return;
    let startIndex = list.findIndex((track) => track.id === startId);
    if (startIndex < 0) startIndex = 0;
    this.queue = setQueue(this.queue, list, startIndex);
    this._reflectQueue();
    this._emit();
    await this._loadTrack(currentTrack(this.queue), { play: true });
    this._savePlayback();
    this._syncMediaSession(true);
  }

  appendQueue(tracks) {
    const list = Array.from(tracks ?? []).filter(Boolean);
    if (!list.length) return;
    const base = this.queue ?? createQueue([]);
    const merged = [...base.tracks, ...list];
    const index = base.index >= 0 ? base.index : 0;
    this.queue = setQueue(base, merged, index);
    this._reflectQueue();
    this._emit();
    this._savePlayback();
    this._syncMediaSession(true);
  }

  toggle() {
    if (!this.player) return;
    if (this._state.current.playing) {
      this.player.pause();
      return;
    }
    const track = this._state.current.track;
    if (!track) return;
    if (this._loadedId !== track.id) {
      void this._loadTrack(track, { play: true, position: this._state.current.position || 0 });
      return;
    }
    this.player.play().catch((error) => {
      this._state.source = { ...this._state.source, error: errorMessage(error) };
      this._state.current.playing = false;
      this._emit();
    });
  }

  async next() {
    const before = this.queue;
    const { state } = advance(before, { auto: false });
    if (state === before) {
      this._emit();
      return;
    }
    this.queue = state;
    this._reflectQueue();
    this._emit();
    await this._loadTrack(currentTrack(this.queue), { play: true });
    this._savePlayback();
    this._syncMediaSession(true);
  }

  async prev() {
    const before = this.queue;
    const { state } = back(before);
    if (state === before) {
      this._emit();
      return;
    }
    this.queue = state;
    this._reflectQueue();
    this._emit();
    await this._loadTrack(currentTrack(this.queue), { play: true });
    this._savePlayback();
    this._syncMediaSession(true);
  }

  async seek(seconds) {
    const value = Math.max(Number(seconds) || 0, 0);
    this._state.current.position = value;
    this.player?.seek(value);
    this._emit();
    this._savePlayback();
    this._syncMediaSession(true);
  }

  setVolume(value) {
    const volume = clamp(Number(value) || 0, 0, 1);
    this._state.current.volume = volume;
    this.player?.setVolume(volume);
    this._emit();
    this._savePlayback();
  }

  toggleShuffle() {
    this.queue = toggleShuffleState(this.queue);
    this._reflectQueue();
    this._emit();
    this._savePlayback();
    this._syncMediaSession(true);
  }

  cycleRepeat() {
    this.queue = cycleRepeatState(this.queue);
    this._reflectQueue();
    this._emit();
    this._savePlayback();
    this._syncMediaSession(true);
  }

  setSetting(key, value) {
    if (!(key in this._state.settings)) return;
    this._state.settings = { ...this._state.settings, [key]: value };
    void saveSettings(this.db, this._state.settings).catch(() => {});
    this._emit();
  }

  async jumpTo(index) {
    const list = this.queue.tracks;
    if (!Number.isInteger(index) || index < 0 || index >= list.length) return;
    const order = [...this.queue.order];
    let cursor = order.indexOf(index);
    if (cursor < 0) {
      order.unshift(index);
      cursor = 0;
    }
    this.queue = { ...this.queue, index, order, cursor };
    this._reflectQueue();
    this._emit();
    await this._loadTrack(currentTrack(this.queue), { play: true });
    this._savePlayback();
    this._syncMediaSession(true);
  }

  removeQueueAt(index) {
    const before = this.queue;
    const removedCurrent = before.index === index;
    const next = removeAtState(before, index);
    if (next === before) return;
    this.queue = next;
    this._reflectQueue();
    if (removedCurrent) {
      this.player?.pause();
      this._loadedId = null;
      this._state.current.playing = false;
      this._state.current.position = 0;
    }
    this._emit();
    this._savePlayback();
    this._syncMediaSession(true);
  }

  setUpdateReady(flag) {
    this._state.updateReady = Boolean(flag);
    this._emit();
  }

  _emit() {
    this.dispatchEvent(new Event('change'));
  }

  _syncMediaSession(force = false) {
    const now = Date.now();
    if (!force && now - this._lastSyncAt < MEDIA_SYNC_INTERVAL) return;
    this._lastSyncAt = now;
    syncMediaSession(this._state);
  }

  _savePlayback() {
    try {
      savePlayback(this.db, this._snapshot());
    } catch {
      // Persistence is best-effort.
    }
  }

  _snapshot() {
    return {
      trackId: this._state.current.track?.id ?? null,
      position: this._state.current.position || 0,
      queueIds: this.queue.tracks.map((track) => track.id),
      queueIndex: this.queue.index,
      repeat: this.queue.repeat,
      shuffle: this.queue.shuffle,
      volume: this._state.current.volume,
    };
  }

  _reflectQueue() {
    const queue = this.queue;
    this._state.queue = {
      tracks: queue.tracks,
      index: queue.index,
      shuffle: queue.shuffle,
      repeat: queue.repeat,
    };
    const track = currentTrack(queue);
    const current = this._state.current;
    if (!track) {
      this._state.current = { ...current, track: null, playing: false, position: 0, duration: 0 };
      return;
    }
    if (current.track?.id === track.id) {
      this._state.current = {
        ...current,
        track,
        duration: current.duration || track.duration || 0,
      };
    } else {
      this._state.current = {
        ...current,
        track,
        position: 0,
        duration: track.duration || 0,
      };
    }
  }

  /**
   * Write the duration measured by the audio element back onto the active
   * Track. The same object is shared by state.tracks, queue.tracks and
   * state.current, and the updated Track is persisted.
   */
  _adoptTrackDuration(duration) {
    if (!(duration > 0)) return;
    const track = this._state.current.track;
    if (!track) return;
    if (track.duration !== 0 && Math.abs(track.duration - duration) < 1) return;

    const updated = { ...track, duration };
    this._state.tracks = this._state.tracks.map((item) => (item.id === updated.id ? updated : item));
    this.queue = {
      ...this.queue,
      tracks: this.queue.tracks.map((item) => (item.id === updated.id ? updated : item)),
    };
    this._state.current.duration = duration;
    this._reflectQueue();
    putTracks(this.db, [updated]).catch(() => {});
  }

  _reconcileQueue(removedIds = []) {
    const removed = new Set(removedIds);
    const byId = new Map(this._state.tracks.map((track) => [track.id, track]));
    const queue = this.queue;
    if (!queue.tracks.length) {
      this._reflectQueue();
      return;
    }
    const currentId = currentTrack(queue)?.id ?? null;
    const tracks = [];
    const indexMap = new Map();
    queue.tracks.forEach((track, i) => {
      if (removed.has(track.id)) return;
      indexMap.set(i, tracks.length);
      tracks.push(byId.get(track.id) ?? track);
    });

    if (!tracks.length) {
      this.queue = { ...queue, tracks: [], index: -1, order: [], cursor: 0 };
      this._reflectQueue();
      return;
    }

    const order = queue.order.filter((i) => indexMap.has(i)).map((i) => indexMap.get(i));
    let index = currentId ? tracks.findIndex((track) => track.id === currentId) : -1;
    if (index < 0) index = clamp(queue.index, 0, tracks.length - 1);
    let cursor = order.indexOf(index);
    if (cursor < 0) {
      order.unshift(index);
      cursor = 0;
    }
    this.queue = { ...queue, tracks, index, order, cursor };
    const lostCurrent = Boolean(currentId) && !tracks.some((track) => track.id === currentId);
    this._reflectQueue();
    if (lostCurrent) {
      this.player?.pause();
      this._loadedId = null;
      this._state.current.playing = false;
      this._state.current.position = 0;
    }
  }

  async _loadTrack(track, { play = true, position = 0 } = {}) {
    if (!track || !this.player) return false;
    this._loading = true;
    this._state.current.playing = Boolean(play);
    this._state.current.position = position;
    if (track.duration) this._state.current.duration = track.duration;
    this._pendingSeek = position > 0 ? position : null;
    this._emit();
    try {
      const file = await this.source.getFile(track.path);
      if (currentTrack(this.queue)?.id !== track.id) return false;
      await this.player.load(file);
      this._loadedId = track.id;
      if (this._pendingSeek != null) {
        this.player.seek(this._pendingSeek);
        this._state.current.position = this._pendingSeek;
        this._pendingSeek = null;
      }
      if (play) await this.player.play();
      return true;
    } catch (error) {
      this._state.source = { ...this._state.source, error: errorMessage(error) };
      this._state.current.playing = false;
      this._emit();
      return false;
    } finally {
      this._loading = false;
      this._emit();
    }
  }

  async _handleEnded() {
    const before = this.queue;
    const { state, ended } = advance(before, { auto: true });

    if (state === before) {
      if (ended) {
        this._state.current.playing = false;
        this._state.current.position = this._state.current.duration || this._state.current.position;
        this._emit();
        this._savePlayback();
        this._syncMediaSession(true);
        return;
      }
      // repeat === 'one': replay the same track
      this._state.current.position = 0;
      try {
        this.player?.seek(0);
        await this.player?.play();
      } catch {
        this._state.current.playing = false;
        this._emit();
      }
      this._savePlayback();
      this._syncMediaSession(true);
      return;
    }

    this.queue = state;
    this._reflectQueue();
    this._emit();
    await this._loadTrack(currentTrack(this.queue), { play: true });
    this._savePlayback();
    this._syncMediaSession(true);
  }
}

export async function createApp() {
  const db = await openDb();
  const store = new Store(db);
  await store.init();
  return store;
}
