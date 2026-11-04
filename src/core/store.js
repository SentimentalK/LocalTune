/**
 * Application store: the single entry point for the UI.
 * Owns the library, the queue, the audio element and persistence, and emits
 * a 'change' event whenever the read-only state snapshot is updated.
 *
 * Two library sources are supported: a local folder (File System Access or
 * `<input webkitdirectory>`) and OneDrive. Each has its own row in
 * `state.sources`; tracks remember which adapter produced them.
 */

import {
  openDb,
  putTracks,
  deleteTracksById,
  getAllTracks,
  getAllStats,
  putStat,
  putStats,
  getMeta,
  setMeta,
  putPlaylist,
  deletePlaylist,
  getAllPlaylists,
} from './db.js';
import { createSource, hasDirectoryPicker } from './source.js';
import { OpfsSource } from './sources/opfs/source.js';
import { defaultLocalMode } from './sources/opfs/mode.js';
import { OneDriveSource } from './sources/onedrive/source.js';
import { AudioCache } from './cache/audioCache.js';
import { createCacheIndex, createPinStore } from './cache/index.js';
import { createPlaylistRepo } from './playlist/repo.js';
import {
  normalizePlaylist,
  missingText,
  sanitizeFileName,
  m3u8Text,
  rematchPlaylist as rematchPlaylistModel,
} from './playlist/model.js';
import { readMetadata, describeTags } from './metadata/index.js';
import { formatTagReport } from './metadata/diagnostics.js';
import { estimateLibrary } from './storage.js';
import { BUILD_VERSION } from './version.js';
import { migrateGarbledTracks, TAG_PARSER_VERSION, selectRereadTargets } from './migrate.js';
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
import { PlayLog } from './playlog.js';
import { Prefetcher } from './prefetch.js';
import { initInstall } from './install.js';
import { createPlayCounter, applyPlay, ensureAdded } from './stats.js';
import { createSleepTimer } from './sleepTimer.js';
import { decideGain } from './gain.js';
import { parseReplayGain } from './metadata/id3.js';
import { resolveLyrics } from './lyrics/index.js';
import {
  loadPlayback,
  savePlayback,
  loadSettings,
  saveSettings,
  CACHE_LIMIT_VALUES,
  DEFAULT_CACHE_LIMIT_BYTES,
} from './persist.js';
import { installMediaSession, syncMediaSession } from './mediaSession.js';
import { normalizeProxyUrl } from './playlist/sources/proxy.js';
import { t } from '../i18n/index.js';

const VIEWS = new Set(['tracks', 'albums', 'artists', 'folders', 'playlists', 'queue', 'settings', 'lyrics']);
const MEDIA_SYNC_INTERVAL = 1000;
const LYRICS_CACHE_LIMIT = 20;
const REPLAYGAIN_HEAD_BYTES = 1 << 19;
const SOURCE_KINDS = ['local', 'onedrive'];
const TRACK_SOURCE = { local: 'fsa', onedrive: 'onedrive' };
const LOCAL_MODE_KEY = 'localMode';
const ONEDRIVE_SYNC_INTERVAL = 60 * 60 * 1000;

function trackSourceOf(kind) {
  return TRACK_SOURCE[kind] ?? 'fsa';
}

function kindOfTrack(track) {
  return track?.source === 'onedrive' ? 'onedrive' : 'local';
}

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

function emptyRow(kind, adapter) {
  const permission = adapter.permission();
  return {
    id: kind,
    kind: kind === 'onedrive' ? 'onedrive' : adapter.kind,
    name: adapter.name ?? '',
    connected: permission !== 'none',
    permission,
    trackCount: 0,
    scanning: false,
    progress: { done: 0, total: 0 },
    error: null,
    sync: null,
    root: kind === 'onedrive' ? adapter.root()?.path ?? null : null,
  };
}

function buildTrack(entry, meta, { trackSource = 'fsa', externalIds = {} } = {}) {
  const path = entry.path;
  return {
    id: `${trackSource}:${path}`,
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
    source: trackSource,
    externalIds: externalIds && typeof externalIds === 'object' ? externalIds : {},
  };
}

export class Store extends EventTarget {
  constructor(db) {
    super();
    this.db = db;
    this.reference = createSource(db);
    this.opfs = new OpfsSource({ db });
    this.localMode = 'reference';
    this.local = this.reference;
    this.pinStore = createPinStore(db);
    this.playlistRepo = createPlaylistRepo({
      all: () => getAllPlaylists(db),
      put: (playlist) => putPlaylist(db, playlist),
      remove: (id) => deletePlaylist(db, id),
    });
    this.cache = new AudioCache({
      index: createCacheIndex(db),
      pins: this.pinStore,
    });
    this.onedrive = new OneDriveSource({
      meta: {
        get: (key) => getMeta(db, key),
        set: (key, value) => setMeta(db, key, value),
      },
      cache: this.cache,
    });
    this.sources = { local: this.local, onedrive: this.onedrive };

    this.audio = typeof Audio === 'function' ? new Audio() : null;
    if (this.audio && typeof document !== 'undefined' && document?.body) {
      // One media element for the whole app, attached so it is the only
      // `audio` in the document (no per-track elements are created).
      this.audio.setAttribute('aria-hidden', 'true');
      document.body.append(this.audio);
    }
    this.player = this.audio ? new AudioPlayer(this.audio) : null;
    this.queue = createQueue([]);
    this.playlog = new PlayLog(db);
    this.prefetcher = new Prefetcher({
      load: (track) => this._adapterForTrack(track).getFile(track.path),
    });
    this.install = initInstall();
    this.install.onChange(() => this._emit());

    this._scanning = new Set();
    this._migrating = false;
    this._loading = false;
    this._loadedId = null;
    this._pendingSeek = null;
    this._lastSyncAt = 0;
    this._pickerIndex = new Map();
    this._playCounter = createPlayCounter();
    this._lyricsCache = new Map();
    this._sleep = null;
    this._fadeFactor = 1;

    this._state = {
      ready: false,
      view: 'tracks',
      tracks: [],
      queue: { tracks: [], index: -1, shuffle: false, repeat: 'off' },
      current: { track: null, playing: false, position: 0, duration: 0, volume: 1 },
      sources: SOURCE_KINDS.map((kind) => emptyRow(kind, this.sources[kind])),
      onedrivePicker: { open: false, path: '', items: [], loading: false, current: null },
      playlists: [],
      rematch: null,
      stats: {},
      sleep: { mode: 'off', endsAt: null, remaining: null, fading: false },
      lyrics: { trackId: null, loading: false, lines: [], plain: '', source: 'none', error: null },
      settings: {
        language: 'auto',
        cacheLimitBytes: DEFAULT_CACHE_LIMIT_BYTES,
        youtubeApiKey: '',
        playlistProxyUrl: '',
        leveling: false,
        gapless: true,
      },
      pins: [],
      updateReady: false,
      migration: { running: false, done: 0, total: 0, error: null },
    };

    this.#bindPlayer();
    this.#bindDiagnostics();
  }

  get state() {
    return this._state;
  }

  #bindPlayer() {
    const player = this.player;
    if (!player) return;

    const note = (type, detail = {}) =>
      this.log(`audio:${type}`, { position: player.position ?? 0, ...detail });
    player.addEventListener('timeupdate', (event) => {
      const detail = event.detail ?? {};
      const position = Number(detail.position) || 0;
      const duration = Number(detail.duration) || 0;
      this._state.current.position = position;
      if (duration > 0) this._state.current.duration = duration;
      const counted = this._playCounter?.update(position);
      if (counted?.justCounted) this._recordPlay(this._playCounter.trackId);
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
      // Log before advancing so the row order shows ended → trackchange.
      note('ended');
      void this._handleEnded();
    });

    player.addEventListener('play', () => {
      note('play');
      this._state.current.playing = true;
      this._playCounter?.resume(this._state.current.position);
      this._emit();
      this._syncMediaSession(true);
      this._savePlayback();
    });

    player.addEventListener('pause', () => {
      note('pause');
      if (this._loading) return;
      this._state.current.playing = false;
      this._playCounter?.pause();
      this._emit();
      this._syncMediaSession(true);
      this._savePlayback();
    });

    for (const type of ['waiting', 'stalled', 'suspend']) {
      player.addEventListener(type, () => note(type));
    }

    player.addEventListener('error', (event) => {
      const error = event.detail?.error ?? new Error(t('error.store.playFailed'));
      note('error', { error: String(error?.name ?? error) });
      const track = this._state.current.track;
      if (track) this._patchSource(kindOfTrack(track), { error: errorMessage(error) });
      this._state.current.playing = false;
      this._emit();
    });
  }

  #bindDiagnostics() {
    if (typeof document !== 'undefined' && typeof document?.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => {
        // Visibility is recorded only; backgrounding must never pause playback.
        this.log('visibility', { state: document.visibilityState });
      });
    }
    if (typeof window !== 'undefined' && typeof window?.addEventListener === 'function') {
      window.addEventListener('online', () => this.log('network', { online: true }));
      window.addEventListener('offline', () => this.log('network', { online: false }));
    }
  }

  /** Best-effort diagnostic row; never throws into the playback path. */
  log(type, detail = {}) {
    try {
      const trackId = this._state?.current?.track?.id ?? null;
      const online = globalThis.navigator?.onLine ?? true;
      void this.playlog?.record(type, { ...detail, trackId, online });
    } catch {
      // Diagnostics must never break playback.
    }
  }

  async init() {
    try {
      await this.onedrive.handleRedirect();
    } catch {
      // A failed exchange leaves the source signed out; restore() decides.
    }

    const savedMode = await getMeta(this.db, LOCAL_MODE_KEY).catch(() => null);
    this.localMode =
      savedMode === 'import' || savedMode === 'reference'
        ? savedMode
        : defaultLocalMode({
            userAgent: globalThis.navigator?.userAgent ?? '',
            hasPicker: hasDirectoryPicker(),
          });
    this.local = this.localMode === 'import' ? this.opfs : this.reference;
    this.sources.local = this.local;

    try {
      await this.local.restore();
    } catch {
      // A missing or unreadable handle leaves the local source disconnected.
    }
    try {
      await this.onedrive.restore();
    } catch {
      // Same for a malformed token/root entry.
    }

    // The picker only helps while no library root exists: a returning user
    // keeps their last view, and a re-auth redirect that lands with a root
    // must not detour through it again.
    const needsRoot = this.onedrive.permission() !== 'none' && !this.onedrive.hasRoot();
    if (needsRoot) {
      this._state.view = 'settings';
      this._state.onedrivePicker = {
        open: true,
        path: '',
        items: [],
        loading: false,
        current: null,
      };
    }

    if (this.onedrive.hasRoot() && this.onedrive.permission() === 'prompt') {
      // Top-level `prompt=none` redirect; guarded so a broken grant cannot loop.
      await this.onedrive.silentReauth().catch(() => false);
    }

    const tracks = sortTracks(await getAllTracks(this.db).catch(() => []));
    const playlists = await this.playlistRepo.list().catch(() => []);
    const playback = await loadPlayback(this.db).catch(() => null);
    const settings = await loadSettings(this.db).catch(() => ({
      language: 'auto',
      cacheLimitBytes: DEFAULT_CACHE_LIMIT_BYTES,
      youtubeApiKey: '',
      playlistProxyUrl: '',
      leveling: false,
      gapless: true,
    }));
    const pins = await this.pinStore.all().catch(() => []);
    const storedStats = await getAllStats(this.db).catch(() => []);

    this._playCounter = createPlayCounter();
    this._lyricsCache = new Map();
    this._sleep = createSleepTimer({
      now: Date.now,
      onTick: (sleep) => {
        this._state.sleep = sleep;
        this._emit();
      },
      onFade: (factor) => this._applyFade(factor),
      onStop: () => this._stopForSleep(),
    });

    this.cache.limit = settings.cacheLimitBytes;
    this._state.tracks = tracks;
    this._state.playlists = playlists;
    this._state.settings = {
      language: 'auto',
      leveling: false,
      gapless: true,
      ...settings,
    };
    const statsMap = {};
    for (const row of storedStats ?? []) {
      if (!row || typeof row.id !== 'string') continue;
      const { id, ...values } = row;
      statsMap[id] = values;
    }
    const { stats: nextStats, added } = ensureAdded(statsMap, tracks);
    this._state.stats = nextStats;
    if (added.length) {
      void putStats(this.db, added.map((id) => ({ id, ...nextStats[id] }))).catch(() => {});
    }
    this._state.pins = Array.from(pins ?? [])
      .filter((pin) => pin && typeof pin.id === 'string')
      .map((pin) => ({
        id: pin.id,
        source: pin.source,
        dir: pin.dir ?? '',
        running: false,
        done: 0,
        total: 0,
        error: null,
      }));
    this._state.sources = SOURCE_KINDS.map((kind) => ({
      ...emptyRow(kind, this.sources[kind]),
      trackCount: this._countTracks(kind),
    }));

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

    if (this._state.onedrivePicker.open && this.onedrive.permission() === 'granted') {
      void this.browseOneDrive('');
    }

    if (this.onedrive.hasRoot() && this.onedrive.permission() === 'granted') {
      const lastScan = await getMeta(this.db, 'lastScanBySource').catch(() => null);
      const at = lastScan?.onedrive?.at ?? 0;
      if (Date.now() - at > ONEDRIVE_SYNC_INTERVAL) void this.syncSource('onedrive');
    }
  }

  _countTracks(kind) {
    const trackSource = kind === 'local' ? this.local.trackSource ?? 'fsa' : trackSourceOf(kind);
    return this._state.tracks.filter((track) => track.source === trackSource).length;
  }

  _patchSource(kind, patch) {
    this._state.sources = this._state.sources.map((row) =>
      row.id === kind ? { ...row, ...patch } : row,
    );
  }

  _refreshSource(kind, patch = {}) {
    const adapter = this.sources[kind];
    const permission = adapter.permission();
    this._patchSource(kind, {
      kind: kind === 'onedrive' ? 'onedrive' : adapter.kind,
      name: adapter.name ?? '',
      connected: permission !== 'none',
      permission,
      trackCount: this._countTracks(kind),
      root: kind === 'onedrive' ? adapter.root()?.path ?? null : null,
      ...(kind === 'local' ? { mode: this.localMode } : {}),
      ...patch,
    });
  }

  _adapterForTrack(track) {
    if (track?.source === 'onedrive') return this.onedrive;
    if (track?.source === 'opfs') return this.opfs;
    return this.reference;
  }

  /**
   * Re-read tags when the build or the tag parser changed, plus a mojibake
   * sweep funded by the same pass. Runs in the background after init;
   * playback is never awaited on it.
   */
  async _maybeMigrateTags() {
    if (this._migrating) return;
    this._migrating = true;
    try {
      const last = await getMeta(this.db, 'lastBuildVersion').catch(() => null);
      const lastParser = await getMeta(this.db, 'lastTagParserVersion').catch(() => null);
      if (last === BUILD_VERSION && lastParser === TAG_PARSER_VERSION) return;
      // Without a granted source there is nothing to read; retry next launch
      // or when the user grants permission in this session.
      const kinds = SOURCE_KINDS.filter((kind) => this.sources[kind].permission() === 'granted');
      if (!kinds.length) return;

      const groups = kinds.map((kind) => {
        const list = this._state.tracks.filter((track) => kindOfTrack(track) === kind);
        return {
          kind,
          selected: selectRereadTargets(list, {
            kind,
            parserVersion: TAG_PARSER_VERSION,
            lastParserVersion: lastParser,
          }),
        };
      });
      const total = groups.reduce((sum, group) => sum + group.selected.length, 0);
      this._state.migration = { running: true, done: 0, total, error: null };
      this._emit();

      try {
        const changed = [];
        let base = 0;
        for (const { kind, selected } of groups) {
          const { changed: groupChanged } = await migrateGarbledTracks({
            tracks: selected,
            getFile: (path) => (kind === 'local' ? this.local : this.sources[kind]).getFile(path),
            readMetadata,
            shouldRead: () => true,
            onProgress: ({ done }) => {
              this._state.migration = { ...this._state.migration, done: base + done, total };
              if (done % 5 === 0 || done === selected.length) this._emit();
            },
          });
          base += selected.length;
          changed.push(...groupChanged);
        }

        if (changed.length) await putTracks(this.db, changed);
        const byId = new Map(changed.map((track) => [track.id, track]));
        this._state.tracks = sortTracks(
          this._state.tracks.map((track) => byId.get(track.id) ?? track),
        );
        this._reconcileQueue([]);
        await setMeta(this.db, 'lastTagParserVersion', TAG_PARSER_VERSION);
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
    this._patchSource('local', { error: null });
    this._emit();
    try {
      if (this.localMode === 'import') {
        this.local.onProgress = (progress) => {
          this._patchSource('local', { progress });
          this._emit();
        };
      }
      await this.local.connect();
      this._refreshSource('local');
      this._emit();
      await this.rescan('local');
      void this._maybeMigrateTags();
    } catch (error) {
      if (error?.name === 'AbortError') return;
      this._refreshSource('local', { error: errorMessage(error) });
      this._emit();
    }
  }

  async requestSourcePermission() {
    const granted = await this.local.ensurePermission().catch(() => false);
    this._refreshSource('local', { error: null });
    this._emit();
    if (granted) {
      await this.rescan('local');
      void this._maybeMigrateTags();
    }
    return granted;
  }

  async connectOneDrive() {
    return this.onedrive.startLogin();
  }

  async browseOneDrive(path = '') {
    this._state.onedrivePicker = { ...this._state.onedrivePicker, open: true, path, loading: true };
    this._emit();
    try {
      const items = await this.onedrive.browse(path);
      for (const item of items) this._pickerIndex.set(item.path, item);
      const current = path ? this._pickerIndex.get(path) ?? null : null;
      this._state.onedrivePicker = { open: true, path, items, loading: false, current };
      this._refreshSource('onedrive', { error: null });
      this._emit();
      return items;
    } catch (error) {
      this._state.onedrivePicker = {
        ...this._state.onedrivePicker,
        open: true,
        path,
        items: [],
        loading: false,
        current: null,
      };
      this._refreshSource('onedrive', { error: errorMessage(error) });
      this._emit();
      return [];
    }
  }

  closeOneDrivePicker() {
    this._state.onedrivePicker = {
      open: false,
      path: '',
      items: [],
      loading: false,
      current: null,
    };
    this._emit();
  }

  async chooseOneDriveRoot({ id, path, name }) {
    const currentRoot = this.onedrive.root();
    await this.onedrive.setRoot({
      driveId: currentRoot?.driveId ?? null,
      itemId: id,
      path,
      name,
    });
    this._refreshSource('onedrive');
    this._emit();
    await this.rescan('onedrive');
    this.closeOneDrivePicker();
  }

  async reauthenticateOneDrive() {
    await this.onedrive.forget();
    this._refreshSource('onedrive', { error: null, sync: null });
    this._emit();
    return this.connectOneDrive();
  }

  async rescan(kind = 'local') {
    const adapter = this.sources[kind];
    if (!adapter || this._scanning.has(kind)) return null;
    this._patchSource(kind, { error: null });
    this._emit();

    if (adapter.permission() !== 'granted') {
      const granted = await adapter.ensurePermission().catch(() => false);
      if (!granted) {
        const permission = adapter.permission();
        this._refreshSource(kind, {
          error:
            permission === 'none'
              ? t('error.store.notConnected')
              : t('error.store.permissionRequired'),
        });
        this._emit();
        return null;
      }
      this._patchSource(kind, { permission: 'granted', connected: true });
    }

    this._scanning.add(kind);
    this._patchSource(kind, {
      scanning: true,
      error: null,
      progress: { done: 0, total: 0 },
    });
    this._emit();

    const trackSource = adapter.trackSource ?? trackSourceOf(kind);
    try {
      const entries = [];
      for await (const entry of adapter.scan()) {
        entries.push(entry);
        this._patchSource(kind, { progress: { done: entries.length, total: 0 } });
        if (entries.length % 25 === 0) this._emit();
      }

      const all = await getAllTracks(this.db).catch(() => this._state.tracks);
      const previous = all.filter((track) => track.source === trackSource);
      const diff = diffScan(previous, entries);
      const byId = new Map(previous.map((track) => [track.id, track]));

      const pending = [...diff.added, ...diff.updated];
      this._patchSource(kind, { progress: { done: 0, total: pending.length } });
      this._emit();

      const fresh = [];
      let done = 0;
      for (const entry of pending) {
        const file = typeof entry.readFile === 'function' ? await entry.readFile() : entry.file;
        const meta = await readMetadata(file);
        const track = buildTrack(entry, meta, {
          trackSource,
          externalIds: entry.externalIds ?? {},
        });
        fresh.push(track);
        byId.set(track.id, track);
        done += 1;
        this._patchSource(kind, { progress: { done, total: pending.length } });
        if (done % 5 === 0 || done === pending.length) this._emit();
      }

      if (fresh.length) await putTracks(this.db, fresh);
      if (diff.removedIds.length) await deleteTracksById(this.db, diff.removedIds);
      for (const id of diff.removedIds) byId.delete(id);

      const others = this._state.tracks.filter((track) => track.source !== trackSource);
      this._state.tracks = sortTracks([...others, ...byId.values()]);
      this._syncStats();

      const summary = {
        at: Date.now(),
        added: diff.added.length,
        updated: diff.updated.length,
        removed: diff.removedIds.length,
      };
      const lastScanBySource = (await getMeta(this.db, 'lastScanBySource').catch(() => null)) ?? {};
      await setMeta(this.db, 'lastScanBySource', { ...lastScanBySource, [kind]: summary });

      // A fresh library may resolve rows that were missing. Matching is
      // best-effort: a failure here never changes the scan result. The first
      // call builds the traditional→simplified table (tens of ms), so this
      // stays inside the scan, never on the playback path.
      if (this._state.playlists.length) {
        try {
          const resolved = new Map();
          let added = 0;
          for (const playlist of this._state.playlists) {
            const result = await rematchPlaylistModel(playlist, this._state.tracks);
            if (!result.added) continue;
            resolved.set(playlist.id, await this.playlistRepo.save(result.playlist));
            added += result.added;
          }
          if (resolved.size) {
            this._state.playlists = this._state.playlists.map(
              (playlist) => resolved.get(playlist.id) ?? playlist,
            );
          }
          if (added > 0) this._state.rematch = { added };
        } catch {
          // Playlists keep their old rows; the scan result still stands.
        }
      }

      this._reconcileQueue(diff.removedIds);
      this._refreshSource(kind, { scanning: false, progress: { done: 0, total: 0 } });
      this._emit();
      this._savePlayback();
      return summary;
    } catch (error) {
      this._refreshSource(kind, {
        scanning: false,
        progress: { done: 0, total: 0 },
        error: errorMessage(error),
      });
      this._emit();
      return null;
    } finally {
      this._scanning.delete(kind);
    }
  }

  async syncSource(kind = 'onedrive') {
    const result = await this.rescan(kind);
    if (result) this._patchSource(kind, { sync: result });
    this._emit();
    return result;
  }

  async rescanTags() {
    if (this._scanning.has('tags')) return;
    this._scanning.add('tags');
    const kinds = SOURCE_KINDS.filter((kind) => this.sources[kind].permission() === 'granted');
    if (!kinds.length) {
      const granted = await this.local.ensurePermission().catch(() => false);
      if (!granted) {
        this._refreshSource('local', { error: t('error.store.permissionRequired') });
        this._scanning.delete('tags');
        this._emit();
        return;
      }
      kinds.push('local');
      this._patchSource('local', { permission: 'granted', connected: true });
    }

    for (const kind of kinds) {
      this._patchSource(kind, {
        scanning: true,
        progress: { done: 0, total: this._countTracks(kind) },
      });
    }
    this._emit();

    try {
      const updated = this._state.tracks.filter((track) => !kinds.includes(kindOfTrack(track)));
      const changed = [];
      for (const kind of kinds) {
        const adapter = this.sources[kind];
        const trackSource = trackSourceOf(kind);
        const list = this._state.tracks.filter((track) => track.source === trackSource);
        let done = 0;
        for (const track of list) {
          try {
            const file = await adapter.getFile(track.path);
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
                {
                  path: track.path,
                  file,
                  mtime: track.mtime,
                  size: track.size,
                  externalIds: track.externalIds ?? {},
                },
                { ...meta, duration: meta.duration > 0 ? meta.duration : track.duration },
                { trackSource, externalIds: track.externalIds ?? {} },
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
          this._patchSource(kind, { progress: { done, total: list.length } });
          if (done % 25 === 0 || done === list.length) this._emit();
        }
      }

      this._state.tracks = sortTracks(updated);
      if (changed.length) await putTracks(this.db, changed);
      this._reconcileQueue([]);
      for (const kind of kinds) {
        this._refreshSource(kind, { scanning: false, progress: { done: 0, total: 0 } });
      }
      this._emit();
      this._savePlayback();
    } catch (error) {
      for (const kind of kinds) {
        this._refreshSource(kind, {
          scanning: false,
          progress: { done: 0, total: 0 },
          error: errorMessage(error),
        });
      }
      this._emit();
    } finally {
      this._scanning.delete('tags');
    }
  }

  setView(view) {
    if (!VIEWS.has(view)) return;
    this._state.view = view;
    this._emit();
  }

  /** Disconnect one source and forget its grant; indexed tracks stay. */
  async removeSource(kind = 'local') {
    const adapter = this.sources[kind];
    if (!adapter) return;
    await adapter.forget().catch(() => {});
    this._refreshSource(kind, { error: null, sync: null });
    this._emit();
  }

  /**
   * Switch the local source between a referenced folder and an OPFS import.
   * Tracks of the old strategy are dropped; imported files are never deleted.
   */
  async setLocalMode(mode) {
    if (mode !== 'import' && mode !== 'reference') return;
    if (mode === this.localMode) return;

    await setMeta(this.db, LOCAL_MODE_KEY, mode);
    const previousSource = this.local.trackSource ?? 'fsa';
    this.localMode = mode;
    this.local = mode === 'import' ? this.opfs : this.reference;
    this.sources.local = this.local;

    const nextSource = this.local.trackSource ?? 'fsa';
    const removedIds = this._state.tracks
      .filter((track) => track.source === previousSource && track.source !== nextSource)
      .map((track) => track.id);
    if (removedIds.length) {
      await deleteTracksById(this.db, removedIds);
      const removed = new Set(removedIds);
      this._state.tracks = this._state.tracks.filter((track) => !removed.has(track.id));
    }
    this._reconcileQueue(removedIds);

    await this.local.restore().catch(() => {});
    this._refreshSource('local');
    this._emit();
  }

  /** Drop the imported OPFS folder and the tracks it produced. */
  async clearImported() {
    await this.opfs.clear();
    const removedIds = this._state.tracks
      .filter((track) => track.source === 'opfs')
      .map((track) => track.id);
    if (removedIds.length) await deleteTracksById(this.db, removedIds);
    const removed = new Set(removedIds);
    this._state.tracks = this._state.tracks.filter((track) => !removed.has(track.id));
    this._reconcileQueue(removedIds);
    this._refreshSource('local');
    this._emit();
  }

  /** Delete every indexed track, stop playback and persist the empty state. */
  async clearLibrary() {
    const ids = this._state.tracks.map((track) => track.id);
    await deleteTracksById(this.db, ids);
    this.player?.pause();
    this._loadedId = null;
    this._state.tracks = [];
    this._state.stats = {};
    this.queue = createQueue([]);
    this._reflectQueue();
    this._state.current = {
      ...this._state.current,
      track: null,
      playing: false,
      position: 0,
      duration: 0,
    };
    for (const kind of SOURCE_KINDS) this._refreshSource(kind);
    this._emit();
    this._savePlayback();
  }

  /** Index, cover, cached-audio and browser quota figures for the settings view. */
  async storageEstimate() {
    const { indexBytes, coverBytes } = await estimateLibrary(this._state.tracks);
    const audioBytes = await this.cache.total().catch(() => 0);
    const imported = await this.opfs.usage().catch(() => ({ bytes: 0, count: 0 }));
    let usage = null;
    let quota = null;
    try {
      const estimate = await globalThis.navigator?.storage?.estimate?.();
      if (Number.isFinite(estimate?.usage)) usage = estimate.usage;
      if (Number.isFinite(estimate?.quota)) quota = estimate.quota;
    } catch {
      // Quota is optional; the two library figures still render.
    }
    return {
      indexBytes,
      coverBytes,
      audioBytes,
      usage,
      quota,
      limitBytes: this.cache.limit,
      pinnedCount: this._state.pins.length,
      importBytes: imported.bytes,
      importCount: imported.count,
    };
  }

  /** Drop cached audio responses and the pins that protected them. */
  async clearAudioCache() {
    const released = await this.cache.clear();
    const pins = this._state.pins;
    this._state.pins = [];
    for (const pin of pins) await this.pinStore.delete(pin.id).catch(() => {});
    this._emit();
    return released;
  }

  /** Whether a source's `dir` (or its whole root) is kept for offline use. */
  isPinned(source, dir) {
    return this._state.pins.some(
      (pin) =>
        pin.source === source &&
        (pin.dir === '' || dir === pin.dir || dir.startsWith(`${pin.dir}/`)),
    );
  }

  /**
   * Keep one source's directory offline: record the pin, then fetch every
   * track once so the cache holds it. Sequential on purpose — a folder pin
   * must not flood the network or the settings view.
   */
  async pinFolder({ source, dir = '', trackIds = [] } = {}) {
    const id = `${source}:${dir}`;
    if (this._state.pins.some((pin) => pin.id === id)) return;

    const ids = Array.from(trackIds ?? []);
    const byId = new Map(this._state.tracks.map((track) => [track.id, track]));
    try {
      await this.pinStore.put({ id, source, dir, at: Date.now() });
    } catch {
      return;
    }

    this._state.pins = [
      ...this._state.pins,
      { id, source, dir, running: true, done: 0, total: ids.length, error: null },
    ];
    this._emit();

    let failures = 0;
    let done = 0;
    for (const trackId of ids) {
      const track = byId.get(trackId);
      if (track) {
        try {
          await this._adapterForTrack(track).getFile(track.path);
        } catch {
          failures += 1;
        }
      } else {
        failures += 1;
      }
      done += 1;
      this._patchPin(id, { done });
      this._emit();
    }

    this._patchPin(id, {
      running: false,
      error: ids.length > 0 && failures === ids.length ? t('settings.storage.pinFailed') : null,
    });
    this._emit();
  }

  /** Forget a pin. Cached blobs stay until the limit or a manual clear. */
  async unpinFolder(id) {
    await this.pinStore.delete(id).catch(() => {});
    this._state.pins = this._state.pins.filter((pin) => pin.id !== id);
    this._emit();
  }

  _patchPin(id, patch) {
    this._state.pins = this._state.pins.map((pin) =>
      pin.id === id ? { ...pin, ...patch } : pin,
    );
  }

  /** Multi-line tag report for one track; errors are left for the dialog. */
  async describeTrackTags(trackId) {
    const track = this._state.tracks.find((item) => item.id === trackId);
    if (!track) throw new Error(t('error.store.trackMissing'));
    const file = await this._adapterForTrack(track).getFile(track.path);
    const described = await describeTags(file);
    return formatTagReport(described);
  }

  async playTrack(trackId, source = 'user') {
    const tracks = this._state.tracks;
    if (!tracks.some((track) => track.id === trackId)) return;
    if (this._state.settings.leveling) this._promoteLeveling();
    await this.playQueue(tracks, trackId, source);
  }

  async playQueue(tracks, startId, source = 'user') {
    const list = Array.from(tracks ?? []);
    if (!list.length) return;
    let startIndex = list.findIndex((track) => track.id === startId);
    if (startIndex < 0) startIndex = 0;
    this.queue = setQueue(this.queue, list, startIndex);
    this._reflectQueue();
    this._emit();
    if (this._state.settings.leveling) this._promoteLeveling();
    await this._loadTrack(currentTrack(this.queue), { play: true, source });
    this._resetLyrics();
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
    this.log('control', { action: 'toggle' });
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
    if (this._state.settings.leveling) this._promoteLeveling();
    this.player.play().catch((error) => {
      this._patchSource(kindOfTrack(track), { error: errorMessage(error) });
      this._state.current.playing = false;
      this._emit();
    });
  }

  /** Resume the already-loaded track without toggling playback state. */
  resume() {
    const track = this._state.current.track;
    if (!track || !this.player) return;
    this.log('control', { action: 'resume' });
    const blocked = (error) => {
      this._state.current.playing = false;
      this.log('playblocked', { error: String(error?.name ?? error) });
      this._emit();
    };
    try {
      if (this._state.settings.leveling) this._promoteLeveling();
      this.player
        .playNow()
        .then(() => {
          this._state.current.playing = true;
          this._syncMediaSession();
        })
        .catch(blocked);
    } catch (error) {
      blocked(error);
    }
  }

  /** Pause unconditionally; used by the media-session pause action. */
  pause() {
    if (!this.player) return;
    this.player.pause();
    this.log('control', { action: 'pause' });
  }

  async playLog() {
    return this.playlog.list();
  }

  async clearPlayLog() {
    await this.playlog.clear();
    this._emit();
  }

  async playLogText() {
    const rows = await this.playlog.list();
    return PlayLog.format(rows, { userAgent: globalThis.navigator?.userAgent ?? '' });
  }

  async next(source = 'user') {
    const before = this.queue;
    const { state } = advance(before, { auto: false });
    if (state === before) {
      this._emit();
      return;
    }
    this.queue = state;
    this._reflectQueue();
    this._emit();
    await this._loadTrack(currentTrack(this.queue), { play: true, source });
    this._savePlayback();
    this._syncMediaSession(true);
  }

  async prev(source = 'user') {
    const before = this.queue;
    const { state } = back(before);
    if (state === before) {
      this._emit();
      return;
    }
    this.queue = state;
    this._reflectQueue();
    this._emit();
    await this._loadTrack(currentTrack(this.queue), { play: true, source });
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

  async setSetting(key, value) {
    if (key === 'leveling' || key === 'gapless') {
      if (typeof value !== 'boolean') return;
      this._state.settings = { ...this._state.settings, [key]: value };
      void saveSettings(this.db, this._state.settings).catch(() => {});
      if (key === 'leveling') {
        if (value) this._promoteLeveling();
        else this.player?.disableLeveling();
      }
      this._emit();
      return;
    }
    if (key === 'cacheLimitBytes') {
      if (!Number.isFinite(value) || !CACHE_LIMIT_VALUES.includes(value)) return;
      const settings = { ...this._state.settings, cacheLimitBytes: value };
      await saveSettings(this.db, settings).catch(() => {});
      this.cache.limit = value;
      this._state.settings = settings;
      this._emit();
      await this.cache.enforceLimit();
      return;
    }
    if (key === 'youtubeApiKey' || key === 'playlistProxyUrl') {
      const limit = key === 'youtubeApiKey' ? 200 : 300;
      const text = typeof value === 'string' ? value.trim().slice(0, limit) : '';
      const clean = key === 'playlistProxyUrl' ? normalizeProxyUrl(text) : text;
      if (key === 'playlistProxyUrl' && text !== '' && clean === '') return;
      this._state.settings = { ...this._state.settings, [key]: clean };
      void saveSettings(this.db, this._state.settings).catch(() => {});
      this._emit();
      return;
    }
    if (!(key in this._state.settings)) return;
    this._state.settings = { ...this._state.settings, [key]: value };
    void saveSettings(this.db, this._state.settings).catch(() => {});
    this._emit();
  }

  /**
   * Resolve lyrics for one track, sidecar `.lrc` first, then embedded tags.
   * Remote or unreadable files end at `source: 'none'`; playback never waits.
   */
  async loadLyrics(trackId) {
    const track = this._state.tracks.find((item) => item.id === trackId) ?? null;
    if (!track) {
      this._state.lyrics = {
        trackId,
        loading: false,
        lines: [],
        plain: '',
        source: 'none',
        error: t('error.store.trackMissing'),
      };
      this._emit();
      return;
    }

    const cached = this._lyricsCache?.get(trackId);
    if (cached) {
      this._lyricsCache.delete(trackId);
      this._lyricsCache.set(trackId, cached);
      this._state.lyrics = { ...cached, trackId, loading: false, error: null };
      this._emit();
      return;
    }

    this._state.lyrics = {
      trackId,
      loading: true,
      lines: [],
      plain: '',
      source: 'none',
      error: null,
    };
    this._emit();

    let resolved = { source: 'none', lines: [], plain: '' };
    try {
      const getFile = (path) => this._adapterForTrack(track).getFile(path);
      resolved = await resolveLyrics({ track, getFile });
    } catch (error) {
      // A missing OneDrive copy or an unreadable file is not an error the UI
      // shows: the track keeps playing without lyrics.
      this.log('lyrics', { error: String(error) });
      resolved = { source: 'none', lines: [], plain: '' };
    }

    const entry = {
      trackId,
      loading: false,
      lines: Array.isArray(resolved?.lines) ? resolved.lines : [],
      plain: typeof resolved?.plain === 'string' ? resolved.plain : '',
      source: resolved?.source ?? 'none',
      error: null,
    };
    this._rememberLyrics(trackId, entry);
    if (this._state.lyrics.trackId === trackId) {
      this._state.lyrics = entry;
      this._emit();
    }
  }

  setSleepMode(mode) {
    if (!this._sleep) return;
    this._sleep.set(mode);
    const sleep = this._sleep.state();
    this._state.sleep = sleep;
    if (sleep.mode === 'off') this._applyFade(1);
    this._emit();
  }

  /** @returns {object} the stored playlist; it is also at the head of state */
  async createPlaylist({ name, source = 'text', sourceUrl = null, items = [] } = {}) {
    const saved = await this.playlistRepo.save(
      normalizePlaylist({ name, source, sourceUrl, items }),
    );
    this._state.playlists = [saved, ...this._state.playlists];
    this._emit();
    return saved;
  }

  async deletePlaylist(id) {
    this.#playlist(id);
    await this.playlistRepo.remove(id);
    this._state.playlists = this._state.playlists.filter((playlist) => playlist.id !== id);
    this._emit();
  }

  /** Tracks behind the matched/suspect rows, in playlist order. */
  async playlistTracks(id) {
    const playlist = this.#playlist(id);
    const items = Array.isArray(playlist.items) ? playlist.items : [];
    const byId = new Map(this._state.tracks.map((track) => [track.id, track]));
    const tracks = [];
    for (const item of items) {
      if (item.status !== 'matched' && item.status !== 'suspect') continue;
      const track = byId.get(item.matchedTrackId);
      if (track) tracks.push(track);
    }
    return tracks;
  }

  async confirmPlaylistItem(id, index) {
    const playlist = this.#playlist(id);
    const item = playlist.items?.[index];
    if (!item || !item.matchedTrackId) return;
    if (item.status !== 'matched' && item.status !== 'suspect') return;
    await this.#updatePlaylistItem(id, index, { status: 'matched', reasons: [] });
  }

  async assignPlaylistItem(id, index, trackId) {
    const playlist = this.#playlist(id);
    if (!playlist.items?.[index]) return;
    if (!this._state.tracks.some((track) => track.id === trackId)) return;
    await this.#updatePlaylistItem(id, index, {
      matchedTrackId: trackId,
      status: 'matched',
      reasons: [],
    });
  }

  /** Re-match the missing rows against the current library; → number added */
  async rematchPlaylist(id) {
    const playlist = this.#playlist(id);
    const result = await rematchPlaylistModel(playlist, this._state.tracks);
    if (!result.added) return 0;
    const saved = await this.playlistRepo.save(result.playlist);
    this._state.playlists = this._state.playlists.map((entry) =>
      entry.id === id ? saved : entry,
    );
    this._emit();
    return result.added;
  }

  async playlistMissingText(id) {
    return missingText(this.#playlist(id));
  }

  /** → { name: 'playlist.m3u8', text } without touching the disk */
  async exportPlaylistM3u8(id) {
    const playlist = this.#playlist(id);
    return {
      name: `${sanitizeFileName(playlist.name)}.m3u8`,
      text: m3u8Text(playlist, this._state.tracks),
    };
  }

  /**
   * Write the `.m3u8` next to the library (reference root or OPFS `music/`).
   * OneDrive playlists and unconnected local sources have no write target.
   */
  async writePlaylistM3u8(id) {
    if (this.local.permission() !== 'granted') {
      throw new Error(t('error.playlist.writeUnsupported'));
    }
    const adapter = this.localMode === 'import' ? this.opfs : this.reference;
    const file = await this.exportPlaylistM3u8(id);
    await adapter.writeTextFile(file.name, file.text);
    return { name: file.name, path: file.name };
  }

  clearRematchNotice() {
    this._state.rematch = null;
    this._emit();
  }

  #playlist(id) {
    const playlist = this._state.playlists.find((entry) => entry.id === id);
    if (!playlist) throw new Error(t('error.playlist.notFound'));
    return playlist;
  }

  async #updatePlaylistItem(id, index, patch) {
    const playlist = this.#playlist(id);
    const items = (playlist.items ?? []).map((item, at) =>
      at === index ? { ...item, ...patch } : item,
    );
    const saved = await this.playlistRepo.save({ ...playlist, items });
    this._state.playlists = this._state.playlists.map((entry) =>
      entry.id === id ? saved : entry,
    );
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
    this._state.install = this.install ? this.install.state() : null;
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

  /** Add zeroed rows for newly indexed tracks and persist only the additions. */
  _syncStats() {
    try {
      const { stats, added } = ensureAdded(this._state.stats, this._state.tracks);
      this._state.stats = stats;
      if (added.length) {
        void putStats(this.db, added.map((id) => ({ id, ...stats[id] }))).catch(() => {});
      }
    } catch {
      // A stats failure must never fail a scan.
    }
  }

  _recordPlay(id) {
    if (!id) return;
    try {
      const row = this._state.stats[id];
      const now = Date.now();
      const play = {
        id,
        plays: (row?.plays ?? 0) + 1,
        lastPlayedAt: now,
        addedAt: row?.addedAt ?? now,
      };
      this._state.stats = applyPlay(this._state.stats, { id, now });
      void putStat(this.db, play).catch(() => {});
      this.log('stats', { id, plays: play.plays });
      this._emit();
    } catch {
      // Counting is best-effort.
    }
  }

  _startPlaySession(track, position = 0) {
    try {
      this._playCounter?.start(track, position);
    } catch {
      // Counting is best-effort.
    }
  }

  _resetLyrics() {
    this._state.lyrics = {
      trackId: null,
      loading: false,
      lines: [],
      plain: '',
      source: 'none',
      error: null,
    };
  }

  _rememberLyrics(trackId, entry) {
    const cache = this._lyricsCache;
    if (!cache) return;
    cache.delete(trackId);
    cache.set(trackId, entry);
    while (cache.size > LYRICS_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
  }

  _promoteLeveling() {
    try {
      void this.player?.enableLeveling()?.catch(() => {});
    } catch {
      // No gesture or no Web Audio: unity gain stays, playback continues.
    }
  }

  /** ReplayGain for one track; every failure falls back to unity gain. */
  async _applyGainForTrack(track) {
    if (!this._state.settings.leveling || !this.player || track?.source === 'onedrive') {
      this.player?.setGain(null);
      return;
    }
    try {
      const file = await this._adapterForTrack(track).getFile(track.path);
      const size = Math.min(Number(file?.size) || 0, REPLAYGAIN_HEAD_BYTES);
      const head = new Uint8Array(await file.slice(0, size).arrayBuffer());
      const tags = parseReplayGain(head);
      const { db } = decideGain(tags, { enabled: true });
      this.player.setGain(db);
    } catch {
      this.player?.setGain(null);
    }
  }

  _applyFade(factor) {
    const value = Number.isFinite(factor) ? clamp(factor, 0, 1) : 1;
    this._fadeFactor = value;
    try {
      this.player?.setVolume(clamp(this._state.current.volume * value, 0, 1));
    } catch {
      // Volume writes are best-effort.
    }
  }

  _stopForSleep() {
    try {
      this.player?.pause();
    } catch {
      // Already stopped.
    }
    if (this._sleep) this._state.sleep = this._sleep.state();
    this._state.current.playing = false;
    this._applyFade(1);
    this.log('sleep', { stopped: true });
    this._emit();
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

  /**
   * Warm the prefetch slot with the track after the current one. Repeat-one
   * keeps the same track, so the current track is the next one there.
   */
  async _primeNext() {
    if (!this.prefetcher) return;
    const { state } = advance(this.queue, { auto: true });
    const next = currentTrack(state);
    if (!next) return;
    if (kindOfTrack(next) !== 'local') {
      // Remote sources fetch a whole file per read; eager prefetch would
      // double the network traffic for tracks that may never play.
      this.log('prefetch', { id: next.id, ok: false, skipped: 'remote' });
      return;
    }
    const result = await this.prefetcher.prime(next);
    this.log('prefetch', { id: next.id, ok: Boolean(result) });
  }

  async _loadTrack(track, { play = true, position = 0, source = 'user' } = {}) {
    if (!track || !this.player) return false;
    this._loading = true;
    this._state.current.playing = Boolean(play);
    this._state.current.position = position;
    if (track.duration) this._state.current.duration = track.duration;
    this._pendingSeek = position > 0 ? position : null;
    this._emit();
    try {
      const file = await this._adapterForTrack(track).getFile(track.path);
      if (currentTrack(this.queue)?.id !== track.id) return false;
      await this.player.load(file);
      this._loadedId = track.id;
      if (this._pendingSeek != null) {
        this.player.seek(this._pendingSeek);
        this._state.current.position = this._pendingSeek;
        this._pendingSeek = null;
      }
      if (play) await this.player.play();
      this.log('trackchange', { source });
      this._startPlaySession(track, this._state.current.position);
      this._resetLyrics();
      void this._applyGainForTrack(track);
      void this._primeNext();
      return true;
    } catch (error) {
      this._patchSource(kindOfTrack(track), { error: errorMessage(error) });
      this._state.current.playing = false;
      this._emit();
      return false;
    } finally {
      this._loading = false;
      this._emit();
    }
  }

  async _handleEnded() {
    if (this._sleep?.state().mode === 'end') {
      // "End of current track" sleep: this is that end; do not advance.
      this._sleep.fireEnd();
      this._savePlayback();
      return;
    }
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
      this.log('trackchange', { source: 'auto', repeat: 'one' });
      this._state.current.position = 0;
      this._state.current.playing = true;
      this._startPlaySession(this._state.current.track, 0);
      const blocked = (error) => {
        this._state.current.playing = false;
        this.log('playblocked', { error: String(error?.name ?? error) });
        this._emit();
      };
      try {
        this.player?.seek(0);
        this.player?.playNow().catch(blocked);
      } catch (error) {
        blocked(error);
      }
      this._emit();
      this._savePlayback();
      this._syncMediaSession(true);
      return;
    }

    const next = currentTrack(state);
    if (!next) {
      this._state.current.playing = false;
      this._emit();
      return;
    }
    const hit = this._state.settings.gapless ? this.prefetcher?.take(next.id) ?? null : null;

    // Update the synchronous state before touching the element so the
    // resulting play/pause events see the new track.
    this.queue = state;
    this._reflectQueue();
    this._state.current = {
      ...this._state.current,
      track: next,
      playing: true,
      position: 0,
      duration: next.duration || 0,
    };
    this._loadedId = next.id;
    this.log('trackchange', { source: 'auto' });

    if (hit) {
      this._startPlaySession(next, 0);
      this._resetLyrics();
      void this._applyGainForTrack(next);
      // No await before loadUrl/playNow: the user gesture's activation is still live.
      const blocked = (error) => {
        this._state.current.playing = false;
        this.log('playblocked', { error: String(error?.name ?? error) });
        this._emit();
      };
      try {
        this.player.loadUrl(hit.url);
        this.player.playNow().catch(blocked);
      } catch (error) {
        blocked(error);
      }
      this._emit();
      this._savePlayback();
      this._syncMediaSession(true);
      void this._primeNext();
      return;
    }

    this.log('prefetch', { id: next.id, ok: false });
    await this._loadTrack(next, { play: true, source: 'auto' });
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
