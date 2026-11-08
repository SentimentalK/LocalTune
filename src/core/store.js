/**
 * Application store: the single entry point for the UI.
 * Owns the library, the queue, the audio element and persistence, and emits
 * a 'change' event whenever the read-only state snapshot is updated.
 *
 * Four library sources are supported: a local folder (File System Access or
 * `<input webkitdirectory>`), OneDrive, Google Drive and Dropbox. Each has its
 * own row in `state.sources`; tracks remember which adapter produced them.
 */

import {
  openDb,
  putTracks,
  deleteTracksById,
  getAllTracks,
  getAllStats,
  putStat,
  putStats,
  clearStats,
  getMeta,
  setMeta,
  updateMeta,
  getCover,
  withoutCover,
} from './db.js';
import { createCoverCache } from './coverCache.js';
import { createSource, hasDirectoryPicker, AUDIO_EXTENSIONS } from './source.js';
import { purgeSourceRows } from './purge.js';
import { detachSource } from './sources/detach.js';
import { OpfsSource } from './sources/opfs/source.js';
import { defaultLocalMode } from './sources/opfs/mode.js';
import { OneDriveSource } from './sources/onedrive/source.js';
import { GdriveSource } from './sources/googledrive/source.js';
import { DropboxSource } from './sources/dropbox/source.js';
import { parseAuthResponse } from './sources/pkce.js';
import { AudioCache, cacheKey } from './cache/audioCache.js';
import { createCacheIndex } from './cache/index.js';
import { readMetadata, describeTags } from './metadata/index.js';
import { enrichTracks } from './enrich.js';
import { formatTagReport } from './metadata/diagnostics.js';
import { estimateLibrary } from './storage.js';
import { BUILD_VERSION } from './version.js';
import { migrateGarbledTracks, TAG_PARSER_VERSION, selectRereadTargets } from './migrate.js';
import { diffScan } from './scan.js';
import {
  createQueue,
  setQueue,
  alignQueue,
  appendQueue as appendQueueState,
  restoreRound,
  moveTo,
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
import { DEMO_BY_ID, DEMO_TRACKS, demoEndFade, isDemoTrack } from './demo.js';
import { parseReplayGain } from './metadata/id3.js';
import {
  loadPlayback,
  savePlayback,
  loadSettings,
  saveSettings,
  CACHE_LIMIT_VALUES,
  DEFAULT_CACHE_LIMIT_BYTES,
} from './persist.js';
import { installMediaSession, syncMediaSession } from './mediaSession.js';
import { load as loadPrefs, save as savePrefs } from './playerPrefs.js';
import { t } from '../i18n/index.js';
import { yieldToMain } from './timing.js';

const VIEWS = new Set(['folders', 'queue', 'search', 'settings', 'vip']);
const MEDIA_SYNC_INTERVAL = 1000;
const QUEUE_ROUND_KEY = 'localtune.queueRound';
const REPLAYGAIN_HEAD_BYTES = 1 << 19;
const SOURCE_KINDS = ['local', 'onedrive', 'gdrive', 'dropbox'];
const TRACK_SOURCE = {
  local: 'fsa',
  onedrive: 'onedrive',
  gdrive: 'gdrive',
  dropbox: 'dropbox',
};
const REMOTE_KINDS = ['onedrive', 'gdrive', 'dropbox'];
const RECONNECT_KINDS = new Set(['gdrive', 'dropbox']);
const LOCAL_MODE_KEY = 'localMode';
const SOURCE_SYNC_INTERVAL = 60 * 60 * 1000;
const ENRICH_FLUSH_EVERY = 25;
const ENRICH_EMIT_INTERVAL = 1000;
const PROGRESS_INTERVAL = 100;
/** Rows per IndexedDB write while indexing a fresh scan. */
const TRACK_WRITE_BATCH = 250;

/**
 * Collapse a progress stream to ~10 Hz. The first value goes out at once, the
 * latest value trails at most one interval later, and `flush` delivers the
 * pending value now (used when the stream ends so no stale frame survives).
 */
function progressThrottle(deliver, interval = PROGRESS_INTERVAL) {
  let last = 0;
  let timer = null;
  let pending = null;
  const send = (value) => {
    last = Date.now();
    deliver(value);
  };
  return (value, { flush = false } = {}) => {
    const now = Date.now();
    if (flush || now - last >= interval) {
      clearTimeout(timer);
      timer = null;
      pending = null;
      send(value);
      return;
    }
    pending = value;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (!pending) return;
      const next = pending;
      pending = null;
      send(next);
    }, interval);
    timer?.unref?.();
  };
}

function trackSourceOf(kind) {
  return TRACK_SOURCE[kind] ?? 'fsa';
}

function kindOfTrack(track) {
  if (track?.source === 'gdrive') return 'gdrive';
  if (track?.source === 'dropbox') return 'dropbox';
  if (track?.source === 'onedrive') return 'onedrive';
  return 'local';
}

function hasAuthStatus(error) {
  for (let item = error; item; item = item.cause) {
    if (item.status === 401) return true;
  }
  return false;
}

function isPermissionFailure(error) {
  for (let item = error; item; item = item.cause) {
    const name = item?.name;
    if (name === 'NotFoundError') return false;
    if (name === 'NotAllowedError' || name === 'SecurityError') return true;
    if (item?.code === 'authRequired') return true;
    if (item?.status === 401) return true;
    const message = typeof item?.message === 'string' ? item.message : '';
    if (/permission|not\s?allowed|auth.*required|unauthori[sz]ed|token.*expir/i.test(message)) {
      return true;
    }
  }
  return false;
}

function permissionReason(kind) {
  if (kind === 'local') return 'permission';
  if (kind === 'gdrive') return 'gesture';
  return 'auth';
}

/** Tracks whose adapter reads over the network instead of the device. */
function isRemoteTrack(track) {
  return track?.source === 'onedrive' || track?.source === 'gdrive' || track?.source === 'dropbox';
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

function queueSession() {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/**
 * The shuffle order survives a reload (no jump back to the round start) but
 * lives only for this tab session: a killed app reshuffles on the next cold
 * start. It is deliberately not part of the IndexedDB playback snapshot.
 */
function loadQueueRound() {
  const storage = queueSession();
  if (!storage) return null;
  try {
    const value = JSON.parse(storage.getItem(QUEUE_ROUND_KEY));
    if (!value || !Array.isArray(value.ids)) return null;
    const ids = value.ids.filter((id) => typeof id === 'string');
    return { ids, indexId: typeof value.indexId === 'string' ? value.indexId : null };
  } catch {
    return null;
  }
}

function saveQueueRound(queue) {
  const storage = queueSession();
  if (!storage) return;
  try {
    if (!queue?.shuffle || !queue.tracks?.length) {
      storage.removeItem(QUEUE_ROUND_KEY);
      return;
    }
    storage.setItem(
      QUEUE_ROUND_KEY,
      JSON.stringify({
        ids: queue.order.map((index) => queue.tracks[index]?.id).filter(Boolean),
        indexId: queue.tracks[queue.index]?.id ?? null,
      }),
    );
  } catch {
    // Session storage is best-effort, like playback persistence.
  }
}

function errorMessage(error) {
  if (!error) return t('common.unknownError');
  if (typeof error === 'string') return error;
  return error.message ? String(error.message) : String(error);
}

/** Errors with dedicated UI copy; everything else leaves the code null. */
const SOURCE_ERROR_CODES = new Set(['notInTestList']);

function sourceErrorCode(error) {
  const code = typeof error?.code === 'string' ? error.code : null;
  return code && SOURCE_ERROR_CODES.has(code) ? code : null;
}

function emptyRow(kind, adapter) {
  const permission = adapter.permission();
  return {
    id: kind,
    kind: adapter.kind,
    name: adapter.name ?? '',
    connected: permission !== 'none',
    permission,
    trackCount: 0,
    scanning: false,
    progress: { done: 0, total: 0 },
    error: null,
    errorCode: null,
    errorStage: null,
    sync: null,
    cacheFailed: 0,
    cacheFailures: [],
    root: adapter.root?.()?.path ?? null,
    configured: typeof adapter.configured === 'function' ? adapter.configured() : true,
    needsReconnect: RECONNECT_KINDS.has(kind) && permission === 'prompt',
  };
}

function isAudioPath(path) {
  const dot = String(path ?? '').lastIndexOf('.');
  return dot >= 0 && AUDIO_EXTENSIONS.has(String(path).slice(dot + 1).toLowerCase());
}

function buildTrack(entry, meta, { trackSource = 'fsa', externalIds = {} } = {}) {
  const path = entry.path;
  const cover = meta.cover instanceof Blob ? meta.cover : null;
  const row = {
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
    hasCover: Boolean(cover),
    coverSize: cover?.size ?? 0,
    coverType: cover?.type || null,
    source: trackSource,
    externalIds: externalIds && typeof externalIds === 'object' ? externalIds : {},
  };
  // Only an actual Blob rides along for this write; a missing `cover` key
  // tells putTracks to leave the covers store untouched.
  if (cover) row.cover = cover;
  return row;
}

/**
 * A fresh metadata read may omit the embedded picture. Keep the stored
 * `hasCover/coverSize/coverType` bookkeeping in that case so a tag refresh
 * never drops artwork the covers store still holds. The transient `cover` key
 * is removed: putTracks treats `cover === null` as an explicit erase.
 *
 * Exported for the regression test (APP-001-AA).
 */
export function carryCover(track, previous) {
  if (track.cover instanceof Blob || !previous?.hasCover) return;
  delete track.cover;
  track.hasCover = true;
  track.coverSize = previous.coverSize ?? 0;
  track.coverType = previous.coverType ?? null;
}

/**
 * Read a blob's duration from a throwaway audio element. Resolves 0 when the
 * element cannot decode it or nothing arrives within `timeout`; never rejects.
 */
export function probeBlobDuration(blob, { timeout = 5000 } = {}) {
  if (typeof Audio !== 'function' || !(blob instanceof Blob)) return Promise.resolve(0);
  const url = URL.createObjectURL(blob);
  const audio = new Audio();
  audio.preload = 'metadata';
  return new Promise((resolve) => {
    let done = false;
    const settle = (value) => {
      if (done) return;
      done = true;
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('durationchange', onMeta);
      audio.removeEventListener('error', onError);
      clearTimeout(timer);
      try {
        audio.removeAttribute('src');
        audio.load?.();
      } catch {
        // A detached element has nothing left to release.
      }
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const onMeta = () => {
      const duration = Number(audio.duration);
      if (Number.isFinite(duration) && duration > 0) settle(duration);
    };
    const onError = () => settle(0);
    const timer = setTimeout(() => settle(0), timeout);
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('durationchange', onMeta);
    audio.addEventListener('error', onError);
    audio.src = url;
  });
}

export class Store extends EventTarget {
  constructor(
    db,
    { readMetadata: readTags = readMetadata, probeDuration = probeBlobDuration } = {},
  ) {
    super();
    this.db = db;
    this._readTags = readTags;
    this._probeDuration = probeDuration;
    this._probes = new Set();
    this._probeChain = Promise.resolve();
    this.covers = createCoverCache({ load: (id) => getCover(this.db, id) });
    this.reference = createSource(db);
    this.opfs = new OpfsSource({ db });
    this.localMode = 'reference';
    this.local = this.reference;
    this.cache = new AudioCache({
      index: createCacheIndex(db),
    });
    const meta = {
      get: (key) => getMeta(db, key),
      set: (key, value) => setMeta(db, key, value),
      update: (key, updater) => updateMeta(db, key, updater),
    };
    this.onedrive = new OneDriveSource({ meta, cache: this.cache });
    this.gdrive = new GdriveSource({ meta, cache: this.cache });
    this.dropbox = new DropboxSource({ meta, cache: this.cache });
    this.sources = {
      local: this.local,
      onedrive: this.onedrive,
      gdrive: this.gdrive,
      dropbox: this.dropbox,
    };

    this.audio = typeof Audio === 'function' ? this._createAudioElement() : null;
    this.player = this.audio
      ? new AudioPlayer(this.audio, { createElement: () => this._createAudioElement() })
      : null;
    this.queue = createQueue([]);
    this.playlog = new PlayLog(db);
    this.prefetcher = new Prefetcher({
      load: (track) => this._adapterForTrack(track).getFile(track.path),
    });
    this.install = initInstall();
    this.install.onChange(() => this._emit());

    this._scanning = new Set();
    this._migrating = false;
    this._enrichQueues = new Map();
    this._loading = false;
    this._pauseAfterLoad = false;
    this._loadedId = null;
    this._pendingSeek = null;
    this._lastSyncAt = 0;
    this._pickerIndex = new Map();
    this._playCounter = createPlayCounter();
    this._sleep = null;
    this._sleepFade = 1;
    this._demoFade = 1;
    this._fadeFactor = 1;
    this._mediaTrackId = null;
    this._mediaUrl = undefined;
    this._mediaPromise = null;
    this._mediaToken = 0;
    this._levelingStreaming = false;
    this._levelingTags = null;
    this._lowPower = false;

    this._state = {
      ready: false,
      view: 'folders',
      pendingView: null,
      tracks: [],
      queue: { tracks: [], index: -1, shuffle: false, repeat: 'off', order: [], cursor: 0 },
      current: { track: null, playing: false, position: 0, duration: 0, volume: 1 },
      sources: SOURCE_KINDS.map((kind) => emptyRow(kind, this.sources[kind])),
      picker: { kind: null, open: false, path: '', items: [], loading: false, current: null },
      stats: {},
      sleep: { mode: 'off', endsAt: null, remaining: null, fading: false },
      settings: {
        language: 'auto',
        cacheLimitBytes: DEFAULT_CACHE_LIMIT_BYTES,
        leveling: false,
        gapless: true,
      },
      updateReady: false,
      migration: { running: false, done: 0, total: 0, error: null },
      permissionIssue: null,
      levelingMode: 'off',
      levelingNote: null,
    };

    this.#bindPlayer();
    this.#bindDiagnostics();
  }

  /**
   * Every media element is created here: a fresh, body-attached element is
   * what makes leaving the Web Audio graph possible at all.
   */
  _createAudioElement() {
    const audio = new Audio();
    audio.setAttribute('aria-hidden', 'true');
    if (typeof document !== 'undefined' && document?.body) document.body.append(audio);
    return audio;
  }

  get state() {
    return this._state;
  }

  /**
   * Object URL for one track's cover. Callers must pair it with
   * `releaseCover(id)` so the cache can revoke it once off screen.
   */
  coverUrl(track) {
    if (!track) return Promise.resolve(null);
    if (track.coverSrc) return Promise.resolve(track.coverSrc);
    if (!track.hasCover || !track.id) return Promise.resolve(null);
    return this.covers.acquire(track.id);
  }

  releaseCover(id) {
    this.covers.release(id);
  }

  /**
   * The underlying File/Blob for a track, used by the scratch Range decoder.
   * FSA/OPFS return metadata without reading audio; remote sources may fill
   * their cache once and the caller reuses the blob for every slice.
   */
  async trackFile(track) {
    if (!track || track.demoUrl) return null;
    const adapter = this._adapterForTrack(track);
    if (!adapter || typeof adapter.getFile !== 'function') return null;
    return adapter.getFile(track.path);
  }

  #bindPlayer() {
    const player = this.player;
    if (!player) return;

    // Leaving the Web Audio graph swaps the element; the store must follow so
    // volume, media session and later loads address the live one.
    player.addEventListener('elementchange', (event) => {
      this.audio = event.detail?.audio ?? this.audio;
    });

    const note = (type, detail = {}) =>
      this.log(`audio:${type}`, { position: player.position ?? 0, ...detail });
    player.addEventListener('timeupdate', (event) => {
      const detail = event.detail ?? {};
      const position = Number(detail.position) || 0;
      const duration = Number(detail.duration) || 0;
      this._state.current.position = position;
      if (duration > 0) this._state.current.duration = duration;
      this._applyDemoFade(
        demoEndFade(this._state.current.track, position, duration || this._state.current.duration),
      );
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

    player.addEventListener('durationchange', (event) => {
      const duration = Number(event.detail?.duration) || 0;
      if (this._adoptTrackDuration(duration)) this._emit();
    });

    player.addEventListener('ended', () => {
      // The fade must never leak into the next track or a replay.
      this._applyDemoFade(1);
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
      // Playback failure is a per-track event; the source row stays healthy.
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
    // Both providers redirect to `/` with `?code=&state=`: the PKCE record the
    // state belongs to decides which handler may consume it. Handlers get the
    // captured search because they clear `location.search` as they run.
    const search = globalThis.location?.search ?? '';
    const params = parseAuthResponse(search);
    let authKind = null;
    if (params.code || params.error) {
      const [dropboxPkce, onedrivePkce] = await Promise.all([
        getMeta(this.db, 'dropboxPkce').catch(() => null),
        getMeta(this.db, 'onedrivePkce').catch(() => null),
      ]);
      if (params.state && dropboxPkce?.state === params.state) authKind = 'dropbox';
      else if (params.state && onedrivePkce?.state === params.state) authKind = 'onedrive';
      else authKind = 'onedrive';
    }

    let redirect = false;
    if (authKind === 'onedrive') {
      try {
        redirect = await this.onedrive.handleRedirect(search);
      } catch {
        // A failed exchange leaves the source signed out; restore() decides.
        redirect = false;
      }
    } else if (authKind === 'dropbox') {
      try {
        redirect = await this.dropbox.handleRedirect(search);
      } catch {
        // Same for Dropbox: the token refresh path reports the failure.
        redirect = false;
      }
    }

    let authFailure = null;
    let authFailureKind = 'onedrive';
    let authStage = 'redirect';

    if (authKind === 'onedrive') {
      const authError = this.onedrive.authError;
      authStage = this.onedrive.authStage ?? 'redirect';
      if (redirect === true) {
        this._state.pendingView = { view: 'settings', section: 'library', picker: 'onedrive' };
        this._state.view = 'settings';
        this.log('onedrive:auth', { stage: 'redirect', ok: true, error: null });
      } else if (redirect === false && authError) {
        this._state.pendingView = { view: 'settings', section: 'library', picker: null };
        this._state.view = 'settings';
        this.log('onedrive:auth', {
          stage: authStage,
          ok: false,
          error: authError,
        });
        authFailure =
          authStage === 'redirect'
            ? t('settings.onedrive.authFailedRedirect')
            : authStage === 'token'
              ? t('settings.onedrive.authFailedToken')
              : authStage === 'pending'
                ? t('settings.onedrive.authFailedPending')
                : t('settings.onedrive.authFailed');
      }
    } else if (authKind === 'dropbox') {
      const authError = this.dropbox.authError;
      authStage = this.dropbox.authStage ?? 'redirect';
      authFailureKind = 'dropbox';
      if (redirect === true) {
        this._state.pendingView = { view: 'settings', section: 'library', picker: 'dropbox' };
        this._state.view = 'settings';
        this.log('dropbox:auth', { stage: 'redirect', ok: true, error: null });
      } else if (redirect === false && authError) {
        this._state.pendingView = { view: 'settings', section: 'library', picker: null };
        this._state.view = 'settings';
        this.log('dropbox:auth', {
          stage: authStage,
          ok: false,
          error: authError,
        });
        authFailure =
          authStage === 'redirect'
            ? t('settings.dropbox.authFailedRedirect')
            : authStage === 'token'
              ? t('settings.dropbox.authFailedToken')
              : authStage === 'pending'
                ? t('settings.dropbox.authFailedPending')
                : t('settings.dropbox.authFailed');
      }
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
    try {
      await this.gdrive.restore();
    } catch {
      // A malformed Google token/root entry is treated as signed out.
    }
    try {
      await this.dropbox.restore();
    } catch {
      // A malformed Dropbox token/root entry is treated as signed out.
    }

    // The picker only helps while no library root exists: a returning user
    // keeps their last view, and a re-auth redirect that lands with a root
    // must not detour through it again. Only the first source that still needs
    // a root opens it; the other keeps its row in settings.
    const pickerKind = REMOTE_KINDS.find(
      (kind) => this.sources[kind].permission() !== 'none' && !this.sources[kind].hasRoot(),
    );
    if (pickerKind) {
      this._state.view = 'settings';
      this._state.picker = {
        kind: pickerKind,
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

    if (
      this.dropbox.hasRoot() &&
      this.dropbox.permission() !== 'granted' &&
      this.dropbox.configured()
    ) {
      // Dropbox refreshes silently instead of redirecting; a dead refresh token
      // just leaves the row at `prompt`.
      await this.dropbox.ensurePermission().catch(() => false);
    }

    const tracks = sortTracks(await getAllTracks(this.db).catch(() => []));
    const playback = await loadPlayback(this.db).catch(() => null);
    // localStorage prefs are written synchronously on every toggle, so they win
    // over a playback snapshot that may still be waiting on its debounce.
    const prefs = loadPrefs();
    const initialShuffle = prefs ? prefs.shuffle : Boolean(playback?.shuffle);
    const initialRepeat = prefs ? prefs.repeat : (playback?.repeat ?? 'off');
    const settings = await loadSettings(this.db).catch(() => ({
      language: 'auto',
      cacheLimitBytes: DEFAULT_CACHE_LIMIT_BYTES,
      leveling: false,
      gapless: true,
    }));
    const storedStats = await getAllStats(this.db).catch(() => []);

    this._playCounter = createPlayCounter();
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
    this._state.sources = SOURCE_KINDS.map((kind) => ({
      ...emptyRow(kind, this.sources[kind]),
      trackCount: this._countTracks(kind),
    }));
    if (authFailure) {
      this._refreshSource(authFailureKind, {
        error: authFailure,
        errorStage: authStage,
      });
    }

    const volume = Number.isFinite(playback?.volume) ? playback.volume : 1;
    const demoDismissed = Boolean(await getMeta(this.db, 'demoDismissed').catch(() => false));
    const byId = new Map(tracks.map((track) => [track.id, track]));
    if (!demoDismissed) {
      for (const [id, track] of DEMO_BY_ID) byId.set(id, track);
    }
    const restored =
      playback?.queueIds?.map((id) => byId.get(id)).filter(Boolean) ?? [];
    const queueTracks = restored.length ? restored : tracks;

    if (queueTracks.length) {
      let startIndex = Number.isInteger(playback?.queueIndex) ? playback.queueIndex : 0;
      if (playback?.trackId) {
        const found = queueTracks.findIndex((track) => track.id === playback.trackId);
        if (found >= 0) startIndex = found;
      }
      startIndex = clamp(startIndex, 0, queueTracks.length - 1);
      this.queue = setQueue(
        { ...createQueue([]), shuffle: initialShuffle, repeat: initialRepeat },
        queueTracks,
        startIndex,
      );
      this.queue = this._applySessionRound(this.queue);
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
    } else if (!demoDismissed) {
      // First launch with an empty library: the demo records live only in the
      // queue. Any play of the user's own music, or clearing/removing them,
      // marks them dismissed permanently.
      this.queue = setQueue(
        { ...createQueue([]), shuffle: initialShuffle, repeat: initialRepeat },
        DEMO_TRACKS,
        0,
      );
      this.queue = this._applySessionRound(this.queue);
      const track = currentTrack(this.queue);
      this._state.current = {
        track,
        playing: false,
        position: 0,
        duration: track.duration,
        volume,
      };
      this.player?.setVolume(volume);
      this._reflectQueue();
    } else {
      this.queue = { ...this.queue, shuffle: initialShuffle, repeat: initialRepeat };
      this._state.current = { track: null, playing: false, position: 0, duration: 0, volume };
      this._state.queue = {
        tracks: [],
        index: -1,
        shuffle: initialShuffle,
        repeat: initialRepeat,
        order: [],
        cursor: 0,
      };
    }

    this._state.ready = true;
    installMediaSession(this);
    this._syncMediaSession(true);
    this._emit();
    void this._maybeMigrateTags();

    const openPicker = this._state.picker.open ? this._state.picker.kind : null;
    if (openPicker && this.sources[openPicker]?.permission() === 'granted') {
      void this.browseSource(openPicker, '');
    }

    const lastScan = await getMeta(this.db, 'lastScanBySource').catch(() => null);
    for (const kind of REMOTE_KINDS) {
      const adapter = this.sources[kind];
      if (!adapter.hasRoot() || adapter.permission() !== 'granted') continue;
      const at = lastScan?.[kind]?.at ?? 0;
      if (Date.now() - at > SOURCE_SYNC_INTERVAL) void this.syncSource(kind);
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

  clearPendingView() {
    if (!this._state.pendingView) return;
    this._state.pendingView = null;
    this._emit();
  }

  _refreshSource(kind, patch = {}) {
    const adapter = this.sources[kind];
    const permission = adapter.permission();
    // A cleared error must not leave a stale dedicated-copy code behind.
    const clearing = patch.error === null && !('errorCode' in patch);
    this._patchSource(kind, {
      kind: adapter.kind,
      name: adapter.name ?? '',
      connected: permission !== 'none',
      permission,
      trackCount: this._countTracks(kind),
      root: adapter.root?.()?.path ?? null,
      configured: typeof adapter.configured === 'function' ? adapter.configured() : true,
      needsReconnect: RECONNECT_KINDS.has(kind) && permission === 'prompt',
      ...(kind === 'local' ? { mode: this.localMode } : {}),
      ...(clearing ? { errorCode: null } : {}),
      ...patch,
    });
  }

  _adapterForTrack(track) {
    if (track?.source === 'gdrive') return this.gdrive;
    if (track?.source === 'dropbox') return this.dropbox;
    if (track?.source === 'onedrive') return this.onedrive;
    if (track?.source === 'opfs') return this.opfs;
    return this.reference;
  }

  async _recoverPermission(kind, error) {
    const adapter = this.sources[kind];
    if (!adapter || typeof adapter.ensurePermission !== 'function') return false;
    const force = kind !== 'local' && kind !== 'gdrive' && hasAuthStatus(error);
    const granted = await adapter
      .ensurePermission(force ? { force: true } : undefined)
      .catch(() => false);
    if (!granted) return false;
    this._refreshSource(kind, { error: null, errorStage: null });
    return true;
  }

  _setPermissionIssue(kind) {
    this._state.permissionIssue = { kind, reason: permissionReason(kind) };
  }

  resolvePermissionIssue() {
    if (!this._state.permissionIssue) return;
    this._state.permissionIssue = null;
    this._emit();
  }

  /**
   * User-gesture recovery from the permission dialog. FSA asks for
   * requestPermission, OneDrive/Dropbox force a token refresh, Google Drive
   * reruns GIS (it must run inside the click). Success retries the current
   * track once; failure leaves the dialog state in place.
   */
  async recoverSource(kind = this._state.permissionIssue?.kind) {
    if (!kind) return false;
    let granted = false;
    if (kind === 'gdrive') {
      granted = await this.reconnectGdrive().catch(() => false);
    } else {
      const adapter = this.sources[kind];
      if (!adapter || typeof adapter.ensurePermission !== 'function') return false;
      granted = await adapter
        .ensurePermission(kind === 'local' ? undefined : { force: true })
        .catch(() => false);
      if (granted) this._refreshSource(kind, { error: null, errorStage: null });
    }
    if (!granted) {
      this._setPermissionIssue(kind);
      this._emit();
      return false;
    }
    this._state.permissionIssue = null;
    this._emit();
    const track = currentTrack(this.queue);
    if (track && kindOfTrack(track) === kind) {
      await this._loadTrack(track, { play: true, source: 'recover', allowRecovery: false });
    }
    return true;
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
        let lastEmit = 0;
        for (const { kind, selected } of groups) {
          const { changed: groupChanged } = await migrateGarbledTracks({
            tracks: selected,
            getFile: (path) => (kind === 'local' ? this.local : this.sources[kind]).getFile(path),
            readMetadata,
            shouldRead: () => true,
            onProgress: ({ done }) => {
              this._state.migration = { ...this._state.migration, done: base + done, total };
              // Same rule as the tag drain: a 1000-row list costs ~150 ms to
              // rebuild, so a per-5-files emit freezes the page for the whole
              // migration. One frame per second plus the last one is enough.
              const now = Date.now();
              if (now - lastEmit >= ENRICH_EMIT_INTERVAL || done === selected.length) {
                lastEmit = now;
                this._emit();
              }
            },
          });
          base += selected.length;
          changed.push(...groupChanged);
        }

        if (changed.length) {
          await putTracks(this.db, changed);
          for (let index = 0; index < changed.length; index += 1) {
            changed[index] = withoutCover(changed[index]);
          }
        }
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
        // Import progress belongs to the header, next to scan and cache
        // progress: the row stays `scanning` from the first copied file until
        // the rescan finishes, so the green bar never blinks out mid-import.
        const report = progressThrottle((progress) => {
          this._patchSource('local', { scanning: true, progress });
          this._emit();
        });
        let latest = { done: 0, total: 0, phase: 'import' };
        this.local.onProgress = (progress) => {
          const phase = progress?.phase;
          if (phase === 'copy') {
            latest = {
              done: Number(progress.copied) || 0,
              total: Number(progress.total) || 0,
              phase: 'import',
            };
          } else if (phase === 'remove') {
            latest = {
              done: Number(progress.removed) || 0,
              total: Number(progress.removedTotal) || 0,
              phase: 'import',
            };
          }
          report(latest, { flush: phase === 'done' });
        };
      }
      const result = await this.local.connect();
      this.local.onProgress = null;
      if (result?.changed) await this._purgeSource('local');
      this._refreshSource('local');
      this._emit();
      await this.rescan('local');
      void this._maybeMigrateTags();
    } catch (error) {
      this.local.onProgress = null;
      this._patchSource('local', {
        scanning: false,
        progress: { done: 0, total: 0 },
        ...(error?.name === 'AbortError' ? {} : { error: errorMessage(error) }),
      });
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

  /**
   * Drop the stale OneDrive grant and restart the redirect. The index and the
   * cached audio survive; the user is asked for a folder again.
   */
  async reconnectOneDrive() {
    await this.onedrive.forget();
    this._refreshSource('onedrive', {
      error: null,
      errorStage: null,
      sync: null,
      cacheFailed: 0,
      cacheFailures: [],
    });
    this._emit();
    return this.connectOneDrive();
  }

  /**
   * Run the GIS token flow and open the Drive picker. A failure lands on the
   * source row; this call never throws.
   */
  async connectGdrive() {
    try {
      await this.gdrive.connect();
      this._refreshSource('gdrive', { error: null, errorStage: null });
      this._emit();
      await this.browseSource('gdrive', '');
      return true;
    } catch (error) {
      const errorCode = sourceErrorCode(error);
      this._refreshSource('gdrive', {
        error: errorMessage(error),
        errorCode,
        // The row owns the actionable update; the raw GIS sentence in the
        // global alert would only duplicate it.
        errorStage: errorCode ? 'gdrive' : null,
      });
      this._emit();
      return false;
    }
  }

  /**
   * Start the Dropbox authorization redirect. An unconfigured build lands on
   * the source row instead of throwing into the UI.
   */
  async connectDropbox() {
    try {
      return await this.dropbox.startLogin();
    } catch (error) {
      const message =
        error?.code === 'not_configured'
          ? t('error.dropbox.notConfigured')
          : errorMessage(error);
      this._refreshSource('dropbox', { error: message });
      this._emit();
      return false;
    }
  }

  /**
   * Drop the stale Dropbox grant and restart the redirect. The index and the
   * cached audio survive; the user is asked for a folder again.
   */
  async reconnectDropbox() {
    await this.dropbox.forget();
    this._refreshSource('dropbox', {
      error: null,
      errorStage: null,
      sync: null,
      cacheFailed: 0,
      cacheFailures: [],
    });
    this._emit();
    return this.connectDropbox();
  }

  async browseSource(kind, path = '') {
    const adapter = this.sources[kind];
    if (!adapter) return [];
    const key = (itemPath) => `${kind}:${itemPath}`;
    this._state.picker = { ...this._state.picker, kind, open: true, path, loading: true };
    this._emit();
    try {
      const items = await adapter.browse(path);
      for (const item of items) this._pickerIndex.set(key(item.path), item);
      const current = path ? this._pickerIndex.get(key(path)) ?? null : null;
      this._state.picker = { kind, open: true, path, items, loading: false, current };
      this._refreshSource(kind, {
        error: null,
        errorStage: null,
        cacheFailed: 0,
        cacheFailures: [],
      });
      this._emit();
      return items;
    } catch (error) {
      this._state.picker = {
        ...this._state.picker,
        kind,
        open: true,
        path,
        items: [],
        loading: false,
        current: null,
      };
      this._refreshSource(kind, {
        error: errorMessage(error),
        cacheFailed: 0,
        cacheFailures: [],
      });
      this._emit();
      return [];
    }
  }

  closePicker() {
    this._state.picker = {
      kind: null,
      open: false,
      path: '',
      items: [],
      loading: false,
      current: null,
    };
    this._emit();
  }

  async chooseSourceRoot(kind, { id, path, name }) {
    const adapter = this.sources[kind];
    if (!adapter) return;
    const previous = adapter.root();
    const cleanPath = String(path ?? '').replace(/^\/+|\/+$/g, '');
    const previousId = previous?.itemId ?? previous?.id ?? null;
    const changed = !previous || previousId !== id || previous.path !== cleanPath;
    if (changed) await this._purgeSource(kind);
    if (kind === 'onedrive') {
      await adapter.setRoot({ driveId: previous?.driveId ?? null, itemId: id, path, name });
    } else {
      await adapter.setRoot({ id, path, name });
    }
    this._refreshSource(kind);
    this._emit();
    this.closePicker();
    await this.rescan(kind);
  }

  /**
   * Re-run GIS for Google Drive. The chosen root, the index and the cached
   * audio all survive: only the short-lived access token is replaced.
   */
  async reconnectGdrive() {
    try {
      await this.gdrive.connect();
      this._refreshSource('gdrive', { error: null, errorStage: null });
      this._emit();
      await this.browseSource('gdrive', '');
      return true;
    } catch (error) {
      const errorCode = sourceErrorCode(error);
      this._refreshSource('gdrive', {
        error: errorMessage(error),
        errorCode,
        errorStage: errorCode ? 'gdrive' : null,
      });
      this._emit();
      return false;
    }
  }

  async rescan(kind = 'local') {
    const adapter = this.sources[kind];
    if (!adapter || this._scanning.has(kind)) return null;
    this._patchSource(kind, { error: null, cacheFailed: 0, cacheFailures: [] });
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

      // Listing phase: new paths become playable placeholders (title falls
      // back to the file name) before any tag is read. Updated paths keep
      // their indexed tags until the background pass replaces them.
      const fresh = diff.added.map((entry) => {
        const track = buildTrack(entry, {}, {
          trackSource,
          externalIds: entry.externalIds ?? {},
        });
        byId.set(track.id, track);
        return track;
      });
      // A 1000-row transaction is a ~200 ms main-thread task on its own; four
      // batches with a frame between them keep input and paint alive.
      for (let index = 0; index < fresh.length; index += TRACK_WRITE_BATCH) {
        await putTracks(this.db, fresh.slice(index, index + TRACK_WRITE_BATCH));
        if (index + TRACK_WRITE_BATCH < fresh.length) await yieldToMain();
      }
      // Rows are written; only cover-free copies may reach in-memory state.
      for (let index = 0; index < fresh.length; index += 1) {
        const row = withoutCover(fresh[index]);
        fresh[index] = row;
        byId.set(row.id, row);
      }
      if (diff.removedIds.length) await deleteTracksById(this.db, diff.removedIds);
      for (const id of diff.removedIds) byId.delete(id);

      const others = this._state.tracks.filter((track) => track.source !== trackSource);
      this._state.tracks = sortTracks([...others, ...byId.values()]);
      this._syncStats();
      this._emit();

      // Pull every listed file into the shared audio cache. Only sources whose
      // files are not already on the device opt in; local files are never copied.
      let warm = null;
      if (adapter.cacheWholeFiles) {
        warm = await this._warmCache(kind, entries);
        // Deleted tracks and leftovers from older builds: keep only the paths
        // in this listing. Index + key scan only, no audio is read.
        try {
          await this.cache.pruneSource(
            trackSource,
            entries.map((entry) => cacheKey(trackSource, entry.path)),
          );
        } catch {
          // Cache cleanup is best effort; the listing itself already landed.
        }
      }

      const summary = {
        at: Date.now(),
        added: diff.added.length,
        updated: diff.updated.length,
        removed: diff.removedIds.length,
        ...(warm ? { cached: warm.cached, cacheFailed: warm.uncached.length } : {}),
      };
      const lastScanBySource = (await getMeta(this.db, 'lastScanBySource').catch(() => null)) ?? {};
      await setMeta(this.db, 'lastScanBySource', { ...lastScanBySource, [kind]: summary });

      this._reconcileQueue(diff.removedIds);
      this._refreshSource(kind, {
        scanning: false,
        progress: { done: 0, total: 0 },
        ...(warm ? { cacheFailed: warm.uncached.length, cacheFailures: warm.uncached } : {}),
      });
      this._emit();
      this._savePlayback();
      if (diff.added.length || diff.updated.length) {
        this._enrich(
          kind,
          [...diff.added, ...diff.updated].map((entry) => ({
            entry,
            trackId: `${trackSource}:${entry.path}`,
          })),
        );
      }
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

  /**
   * Queue tag reads for one source. A single serial worker per source: a
   * second sync merges into the pending map instead of opening a parallel
   * pass, and the caller never awaits the tag pass.
   */
  _enrich(kind, items) {
    let queue = this._enrichQueues.get(kind);
    if (!queue) {
      queue = { running: false, cancelled: false, pending: new Map(), seen: 0 };
      this._enrichQueues.set(kind, queue);
    }
    for (const item of items) {
      if (item?.entry && item.trackId) queue.pending.set(item.trackId, item);
    }
    if (!queue.running) void this._drainEnrich(kind, queue);
  }

  /** Persist accepted tags in batches; stale ids are never written back. */
  async _flushEnriched(accepted) {
    if (!accepted.length) return;
    const present = new Set(this._state.tracks.map((track) => track.id));
    const rows = accepted.filter((track) => present.has(track.id));
    accepted.length = 0;
    if (!rows.length) return;
    try {
      await putTracks(this.db, rows);
    } catch {
      // The in-memory library is already correct; a later pass retries.
    }
  }

  /**
   * Replace one row without re-sorting: the sort key (`path`) never changes
   * here, and sorting 1000 rows once per enriched file is the freeze a large
   * import used to hit.
   */
  _replaceTrack(track) {
    const index = this._state.tracks.findIndex((item) => item.id === track.id);
    if (index < 0) return false;
    const next = this._state.tracks.slice();
    next[index] = track;
    this._state.tracks = next;
    return true;
  }

  /**
   * Background tag drain. Failures are counted per file inside enrichTracks;
   * this loop never touches `sources[kind].error`.
   */
  async _drainEnrich(kind, queue) {
    queue.running = true;
    const adapter = this.sources[kind];
    const trackSource = adapter?.trackSource ?? trackSourceOf(kind);
    const accepted = [];
    let lastEmit = 0;
    try {
      while (!queue.cancelled && queue.pending.size) {
        const batch = Array.from(queue.pending.values());
        queue.pending.clear();
        await enrichTracks({
          items: batch,
          readMetadata: (blob) => this._readTags(blob),
          makeTrack: (entry, meta) =>
            buildTrack(entry, meta, { trackSource, externalIds: entry.externalIds ?? {} }),
          onTrack: async (track) => {
            const previous = this._state.tracks.find((item) => item.id === track.id);
            // A successful tag read also completes the row: the next sync
            // must not re-read this file's cached audio.
            track.metaScanned = true;
            carryCover(track, previous);
            if (!(track.duration > 0) && previous?.duration > 0) {
              track.duration = previous.duration;
            }
            // The cover Blob only survives in the pending write; state gets
            // the cover-free row immediately (see spec APP-001-AA).
            const row = withoutCover(track);
            if (!this._replaceTrack(row)) return;
            if (this.queue.tracks.some((item) => item.id === row.id)) {
              this.queue = {
                ...this.queue,
                tracks: this.queue.tracks.map((item) => (item.id === row.id ? row : item)),
              };
              this._reflectQueue();
            }
            accepted.push(track);
            queue.seen += 1;
            if (queue.seen % ENRICH_FLUSH_EVERY === 0) await this._flushEnriched(accepted);
            // A tag pass over a big folder must not rebuild the list per
            // file: a 1000-row render is ~150 ms, and the rows are already
            // playable placeholders. One refresh per second, plus the final
            // one below, keeps the UI live without stealing the first frame.
            const now = Date.now();
            if (now - lastEmit >= ENRICH_EMIT_INTERVAL) {
              lastEmit = now;
              this._emit();
            }
          },
        });
        await this._flushEnriched(accepted);
      }
    } finally {
      await this._flushEnriched(accepted);
      queue.running = false;
      if (queue.cancelled) return;
      this._reconcileQueue([]);
      this._refreshSource(kind, {});
      this._emit();
      this._savePlayback();
      if (queue.pending.size) {
        // A sync merged work while the final flush was in flight; the queue is
        // still in the map, so restart the worker instead of orphaning it.
        void this._drainEnrich(kind, queue);
      } else {
        this._enrichQueues.delete(kind);
      }
    }
  }

  /**
   * One background duration probe per track. Probes run serially so a library
   * whose tags carry no duration cannot open hundreds of audio elements.
   */
  _probeScannedDuration(id, blob) {
    if (this._probes.has(id)) return;
    this._probes.add(id);
    const task = this._probeChain
      .then(() => this._probeAndAdopt(id, blob))
      .catch(() => {})
      .finally(() => this._probes.delete(id));
    this._probeChain = task;
  }

  async _probeAndAdopt(id, blob) {
    let duration = 0;
    try {
      duration = Number(await this._probeDuration(blob)) || 0;
    } catch {
      duration = 0;
    }
    if (!(duration > 0)) return;
    const track = this._state.tracks.find((item) => item.id === id);
    if (!track || track.duration > 0) return;
    const updated = { ...track, duration };
    this._replaceTrack(updated);
    if (this.queue.tracks.some((item) => item.id === id)) {
      this.queue = {
        ...this.queue,
        tracks: this.queue.tracks.map((item) => (item.id === id ? updated : item)),
      };
      this._reflectQueue();
    }
    putTracks(this.db, [updated]).catch(() => {});
    this._emit();
  }

  /**
   * Write duration, cover and tags for one file that just landed in the cache.
   * A blob from Cache Storage has no filename, so the path supplies the type.
   */
  async _applyFileMetadata(kind, entry, blob) {
    const adapter = this.sources[kind];
    const trackSource = adapter?.trackSource ?? trackSourceOf(kind);
    const id = `${trackSource}:${entry.path}`;
    const previous = this._state.tracks.find((track) => track.id === id);
    if (previous?.metaScanned === true) return;
    let meta = {};
    try {
      meta = await this._readTags(blob, entry.path);
    } catch {
      // Unreadable: leave the row unmarked so the next sync retries it.
      return;
    }
    // The row may have been dropped while metadata was being read; writing it
    // now would resurrect a deleted track.
    if (!this._state.tracks.some((track) => track.id === id)) return;
    const useful =
      meta?.duration > 0 || meta?.cover || meta?.title || meta?.artist || meta?.album;
    const track = useful
      ? buildTrack(entry, meta, {
          trackSource,
          externalIds: entry.externalIds ?? previous?.externalIds ?? {},
        })
      : previous
        ? { ...previous }
        : buildTrack(entry, {}, { trackSource, externalIds: entry.externalIds ?? {} });
    if (useful) carryCover(track, previous);
    if (!(track.duration > 0) && previous?.duration > 0) track.duration = previous.duration;
    // A successful read completes the row even when the file carries no cover
    // or tags, so later syncs can skip the cached blob entirely.
    track.metaScanned = true;
    try {
      await putTracks(this.db, [track]);
    } catch {
      // The row is already on screen; the next sync writes it again.
    }
    const row = withoutCover(track);
    if (!this._replaceTrack(row)) return;
    if (this.queue?.tracks?.some((item) => item.id === id)) {
      this.queue = {
        ...this.queue,
        tracks: this.queue.tracks.map((item) => (item.id === id ? row : item)),
      };
      this._reflectQueue();
    }
    if (!(track.duration > 0) && isAudioPath(entry.path)) {
      this._probeScannedDuration(track.id, blob);
    }
  }

  /**
   * Pull every listed file into `AudioCache` so playback reads the cache.
   * Sequential on purpose: one failed track never stops the rest, and the
   * source itself stays healthy. A path counts as cached only when the Cache
   * Storage response is present after the write.
   */
  async _warmCache(kind, entries) {
    const adapter = this.sources[kind];
    const trackSource = adapter.trackSource ?? trackSourceOf(kind);
    const total = entries.length;
    const uncached = [];
    let cached = 0;
    let done = 0;
    const report = progressThrottle((progress) => {
      this._patchSource(kind, { progress });
      this._emit();
    });
    if (total > 0) report({ done: 0, total, phase: 'cache' });
    const byId = new Map(this._state.tracks.map((track) => [track.id, track]));
    for (const entry of entries) {
      const key = cacheKey(trackSource, entry.path);
      let present = false;
      try {
        present = await this.cache.has(key);
      } catch {
        present = false;
      }
      let blob = null;
      if (!present) {
        try {
          blob = await adapter.getFile(entry.path, {
            awaitCache: true,
            itemId: entry.externalIds?.[trackSource] ?? null,
          });
          present = await this.cache.has(key);
        } catch (error) {
          present = false;
          this.log('cache', {
            id: `${trackSource}:${entry.path}`,
            ok: false,
            error: String(error?.cause?.message ?? error?.message ?? error),
          });
        }
      }
      if (present) {
        cached += 1;
        // Metadata that is already complete needs no blob: the old row is
        // authoritative and a resync must not re-read the whole library.
        const known = byId.get(`${trackSource}:${entry.path}`);
        const complete = known?.metaScanned === true;
        if (!complete) {
          if (!blob && this.cache?.read) {
            try {
              blob = await this.cache.read(key);
            } catch {
              blob = null;
            }
          }
          // Duration and cover come from the file itself. Write them as soon
          // as this one file is on device, before the rest of the library lands.
          if (blob) await this._applyFileMetadata(kind, entry, blob);
        }
      } else {
        uncached.push(entry.path);
      }
      done += 1;
      report({ done, total, phase: 'cache' });
      await yieldToMain(this._lowPower ? 200 : 0);
      if (adapter.permission() !== 'granted') {
        // Auth died mid-pass; retrying the rest would only storm the network.
        for (const rest of entries.slice(done)) uncached.push(rest.path);
        break;
      }
    }
    if (total > 0) report({ done, total, phase: 'cache' }, { flush: true });
    return { cached, uncached };
  }

  async syncSource(kind) {
    const result = await this.rescan(kind);
    if (result) this._patchSource(kind, { sync: result });
    this._emit();
    return result;
  }

  setView(view) {
    if (!VIEWS.has(view)) return;
    this._state.view = view;
    this._emit();
  }

  /**
   * UI hint for background work: while low-power playback is on, the cache
   * warm-up pass yields longer between files. Session-only, never emits.
   */
  setLowPower(active) {
    this._lowPower = Boolean(active);
  }

  /**
   * Drop one source's index rows, cached audio and pending tag reads without
   * touching its stored root. Used by remove and by every folder switch.
   */
  async _purgeSource(kind) {
    const adapter = this.sources[kind];
    if (!adapter) return [];
    const trackSource = adapter.trackSource ?? trackSourceOf(kind);
    const removedIds = await purgeSourceRows({
      source: trackSource,
      tracks: this._state.tracks,
      deleteTracks: (ids) => deleteTracksById(this.db, ids),
      cache: this.cache,
      onRemoved: (ids) => {
        const removed = new Set(ids);
        this._state.tracks = this._state.tracks.filter((track) => !removed.has(track.id));
        this._reconcileQueue(ids);
      },
    });
    const queue = this._enrichQueues.get(kind);
    if (queue) {
      queue.cancelled = true;
      queue.pending.clear();
      this._enrichQueues.delete(kind);
    }
    const prefix = `${kind}:`;
    for (const key of this._pickerIndex.keys()) {
      if (key.startsWith(prefix)) this._pickerIndex.delete(key);
    }
    this._refreshSource(kind);
    this._emit();
    return removedIds;
  }

  /**
   * Disconnect one source and drop everything derived from it: its track
   * index rows, its cached audio and its pending tag reads.
   */
  async removeSource(kind = 'local') {
    const adapter = this.sources[kind];
    if (!adapter) return;

    await this._purgeSource(kind);

    await detachSource(adapter);
    this._refreshSource(kind, {
      error: null,
      sync: null,
      cacheFailed: 0,
      cacheFailures: [],
    });
    this._emit();
    this._savePlayback();
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

  /**
   * Clear every derived piece of library storage but keep the user's sources
   * and settings. The next launch may sync again; this call does not.
   */
  async clearAll() {
    this.player?.pause();
    this.player?.unload?.();
    this._loadedId = null;

    const ids = this._state.tracks.map((track) => track.id);
    if (ids.length) await deleteTracksById(this.db, ids);
    await this.cache.clear().catch(() => 0);
    await clearStats(this.db).catch(() => {});
    await this.playlog.clear().catch(() => {});
    const lastScan = (await getMeta(this.db, 'lastScanBySource').catch(() => null)) ?? {};
    const resetScan = { ...lastScan };
    for (const kind of SOURCE_KINDS) {
      resetScan[kind] = { ...(lastScan[kind] ?? {}), at: 0 };
    }
    await setMeta(this.db, 'lastScanBySource', resetScan).catch(() => {});

    this._state.tracks = [];
    this._state.stats = {};
    this._state.migration = { running: false, done: 0, total: 0, error: null };
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
    this._syncMediaSession?.(true);
  }

  /** Empty the play queue; the library and the playing file stay untouched. */
  clearQueue() {
    if (!this.queue.tracks.length) return;
    if (this.queue.tracks.some(isDemoTrack)) {
      void setMeta(this.db, 'demoDismissed', true).catch(() => {});
    }
    this.player?.pause();
    this._loadedId = null;
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
    this._syncMediaSession(true);
  }

  /** Index, cover, cached-audio and browser quota figures for the settings view. */
  async storageEstimate() {
    const { indexBytes, coverBytes } = await estimateLibrary(this._state.tracks);
    const audioBytes = await this.cache.total().catch(() => 0);
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
    };
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
    this._applyLevelingPolicy();
    await this.playQueue(tracks, trackId, source);
  }

  /**
   * Start (or continue) playback over `tracks`.
   *
   * With shuffle on and the same id set already queued, the running round is
   * kept: order entries are remapped by id and the playhead moves to the
   * requested track. Tapping a row is "play it now"; it must not recycle the
   * tracks already played into the pool (that caused duplicate/skip rounds).
   * `fresh` is for explicit round restarts (play all / shuffle play), and
   * `shuffle` forces the mode before the round is built.
   */
  async playQueue(tracks, startId, source = 'user', { fresh = false, shuffle = null } = {}) {
    const list = Array.from(tracks ?? []);
    if (!list.length) return;
    if (!list.some(isDemoTrack) && this.queue.tracks.some(isDemoTrack)) {
      void setMeta(this.db, 'demoDismissed', true).catch(() => {});
    }
    let startIndex = list.findIndex((track) => track.id === startId);
    if (startIndex < 0) startIndex = 0;
    if (typeof shuffle === 'boolean' && shuffle !== this.queue.shuffle) {
      this.queue = { ...this.queue, shuffle };
      savePrefs({ shuffle, repeat: this.queue.repeat });
    }
    const aligned = !fresh && this.queue.shuffle ? alignQueue(this.queue, list, startIndex) : null;
    this.queue = aligned ?? setQueue(this.queue, list, startIndex);
    this._reflectQueue();
    this._emit();
    this._applyLevelingPolicy();
    await this._loadTrack(currentTrack(this.queue), { play: true, source });
    this._savePlayback();
    this._syncMediaSession(true);
  }

  /** 「随机播放」: one new round over the original order, random opening track. */
  async shufflePlay(tracks, source = 'user') {
    const list = Array.from(tracks ?? []);
    if (!list.length) return;
    const start = list[Math.floor(Math.random() * list.length)];
    await this.playQueue(list, start?.id, source, { fresh: true, shuffle: true });
  }

  appendQueue(tracks) {
    const list = Array.from(tracks ?? []).filter(Boolean);
    if (!list.length) return;
    this.queue = appendQueueState(this.queue ?? createQueue([]), list);
    this._reflectQueue();
    this._emit();
    this._savePlayback();
    this._syncMediaSession(true);
  }

  toggle() {
    if (!this.player) return;
    this.log('control', { action: 'toggle' });
    if (this._loading) {
      // The load will start playback a moment later. The first tap parks it;
      // a second tap before the load finishes lets it play.
      this._pauseAfterLoad = !this._pauseAfterLoad;
      this._state.current.playing = !this._pauseAfterLoad;
      this._emit();
      return;
    }
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
    this._applyLevelingPolicy();
    this.player.play().catch((error) => {
      this._state.current.playing = false;
      this.log('playblocked', { error: String(error?.name ?? error) });
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
      this._applyLevelingPolicy();
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

  /**
   * Drag preview: move the element and the position cursor without emitting or
   * persisting. Gestures call this at ~10 Hz while the finger moves and commit
   * the final value through `seek()`, so a scrub never writes localStorage or
   * repaints the whole shell per pointer event.
   */
  seekPreview(seconds) {
    const duration = this._state.current.duration || this._state.current.track?.duration || 0;
    const value = Math.max(Number(seconds) || 0, 0);
    const target = duration > 0 ? Math.min(value, duration) : value;
    this._state.current.position = target;
    this.player?.seek(target);
    return target;
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
    savePrefs({ shuffle: this.queue.shuffle, repeat: this.queue.repeat });
    this._savePlayback();
    this._syncMediaSession(true);
  }

  cycleRepeat() {
    this.queue = cycleRepeatState(this.queue);
    this._reflectQueue();
    this._emit();
    savePrefs({ shuffle: this.queue.shuffle, repeat: this.queue.repeat });
    this._savePlayback();
    this._syncMediaSession(true);
  }

  async setSetting(key, value) {
    if (key === 'leveling' || key === 'gapless') {
      if (typeof value !== 'boolean') return;
      this._state.settings = { ...this._state.settings, [key]: value };
      void saveSettings(this.db, this._state.settings).catch(() => {});
      if (key === 'leveling') {
        if (value === false) {
          this.player?.disableLeveling();
        } else {
          this._applyLevelingPolicy();
          const tags = this._levelingTags;
          if (tags?.trackId === this._state.current.track?.id && tags.db != null) {
            this.player?.setGain(tags.db);
          } else {
            this.player?.setGain(null);
          }
        }
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
    if (!(key in this._state.settings)) return;
    this._state.settings = { ...this._state.settings, [key]: value };
    void saveSettings(this.db, this._state.settings).catch(() => {});
    this._emit();
  }

  setSleepMode(mode) {
    if (!this._sleep) return;
    this._sleep.set(mode);
    const sleep = this._sleep.state();
    this._state.sleep = sleep;
    if (sleep.mode === 'off') this._applyFade(1);
    this._emit();
  }

  /** Play the queue entry at `index` now; the running round is not rebuilt. */
  async jumpTo(index) {
    const next = moveTo(this.queue, index);
    if (next === this.queue) return;
    this.queue = next;
    this._reflectQueue();
    this._emit();
    await this._loadTrack(currentTrack(this.queue), { play: true });
    this._savePlayback();
    this._syncMediaSession(true);
  }

  removeQueueAt(index) {
    const before = this.queue;
    if (isDemoTrack(before.tracks[index])) {
      void setMeta(this.db, 'demoDismissed', true).catch(() => {});
    }
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
    this._syncLevelingState();
    this._state.install = this.install ? this.install.state() : null;
    this.dispatchEvent(new Event('change'));
  }

  _syncMediaSession(force = false) {
    const now = Date.now();
    if (!force && now - this._lastSyncAt < MEDIA_SYNC_INTERVAL) return;
    this._lastSyncAt = now;

    const track = this._state.current.track;
    const nextId = track?.id ?? null;
    if (nextId !== this._mediaTrackId) {
      const previous = this._mediaTrackId;
      this._mediaTrackId = nextId;
      this._mediaUrl = undefined;
      this._mediaPromise = null;
      if (previous) this.releaseCover(previous);
    }

    const token = (this._mediaToken += 1);
    const deliver = (url) => {
      if (token !== this._mediaToken) return; // a newer sync already won
      syncMediaSession(this._state, url ?? null);
    };

    if (!track) {
      this._mediaUrl = null;
      deliver(null);
      return;
    }
    if (track.coverSrc) {
      this._mediaUrl = track.coverSrc;
      deliver(track.coverSrc);
      return;
    }
    if (!track.hasCover) {
      this._mediaUrl = null;
      deliver(null);
      return;
    }
    if (this._mediaUrl !== undefined) {
      deliver(this._mediaUrl);
      return;
    }
    if (!this._mediaPromise) {
      this._mediaPromise = this.covers.acquire(track.id).finally(() => {
        this._mediaPromise = null;
      });
    }
    this._mediaPromise.then(
      (url) => {
        if (this._mediaTrackId !== nextId) return;
        this._mediaUrl = url ?? null;
        deliver(this._mediaUrl);
      },
      () => {
        if (this._mediaTrackId !== nextId) return;
        this._mediaUrl = null;
        deliver(null);
      },
    );
  }

  _applySessionRound(queue) {
    if (!queue.shuffle) return queue;
    return restoreRound(queue, loadQueueRound()) ?? queue;
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

  /** Mirror the player's graph state into the read-only snapshot. */
  _syncLevelingState() {
    const enabled = this._state.settings.leveling === true;
    const player = this.player;
    let mode = 'off';
    let note = null;
    if (enabled) {
      if (this._levelingStreaming) note = 'streaming';
      else if (player?.levelingReady) mode = player.levelingMode ?? 'off';
    }
    this._state.levelingMode = mode;
    this._state.levelingNote = note;
  }

  async _promoteLeveling() {
    if (this._levelingStreaming) return false;
    try {
      return (await this.player?.enableLeveling?.()) ?? false;
    } catch {
      return false;
    }
  }

  /**
   * One decision point for the graph: streaming sources stay out of Web Audio
   * entirely, everything else may build it.
   */
  _applyLevelingPolicy() {
    if (!this._state.settings.leveling) {
      this.player?.disableLeveling();
      return;
    }
    if (this._levelingStreaming) return;
    void this._promoteLeveling();
  }

  /**
   * ReplayGain for one track. The blob comes from `_loadTrack` so a track is
   * read once; no blob means no gain (unity) rather than a second read.
   */
  async _applyGainForTrack(track, blob) {
    if (!this._state.settings.leveling || !this.player) {
      this.player?.setGain(null);
      this._levelingTags = null;
      return;
    }
    this._levelingTags = { trackId: track?.id ?? null, db: null };
    if (!blob) {
      this.player.setGain(null);
      return;
    }
    try {
      const size = Math.min(Number(blob.size) || 0, REPLAYGAIN_HEAD_BYTES);
      const head = new Uint8Array(await blob.slice(0, size).arrayBuffer());
      const tags = parseReplayGain(head);
      const { db } = decideGain(tags, { enabled: true });
      this.player.setGain(db);
      this._levelingTags = { trackId: track?.id ?? null, db: db ?? null };
    } catch {
      this.player?.setGain(null);
      this._levelingTags = { trackId: track?.id ?? null, db: null };
    }
  }

  _applyFade(factor) {
    this._sleepFade = Number.isFinite(factor) ? clamp(factor, 0, 1) : 1;
    this._syncFade();
  }

  _applyDemoFade(factor) {
    this._demoFade = Number.isFinite(factor) ? clamp(factor, 0, 1) : 1;
    this._syncFade();
  }

  _syncFade() {
    const factor = Math.min(this._sleepFade, this._demoFade);
    this._fadeFactor = factor;
    try {
      this.player?.setVolume(clamp(this._state.current.volume * factor, 0, 1));
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
      order: queue.order,
      cursor: queue.cursor,
    };
    // Rewriting the round for every metadata refill would serialise the whole
    // order hundreds of times per import; the round itself only changes when
    // `order` or the playhead changes.
    const saved = this._savedRound;
    if (!saved || saved.order !== queue.order || saved.index !== queue.index) {
      saveQueueRound(queue);
      this._savedRound = { order: queue.order, index: queue.index };
    }
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
    if (!(duration > 0)) return false;
    const track = this._state.current.track;
    if (!track) return false;
    if (track.duration > 0 && Math.abs(track.duration - duration) < 1) return false;

    const updated = { ...track, duration };
    this._state.tracks = this._state.tracks.map((item) => (item.id === updated.id ? updated : item));
    this.queue = {
      ...this.queue,
      tracks: this.queue.tracks.map((item) => (item.id === updated.id ? updated : item)),
    };
    this._state.current.duration = duration;
    this._reflectQueue();
    putTracks(this.db, [updated]).catch(() => {});
    return true;
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
    const oldToNew = new Map();
    const positionById = new Map();
    queue.tracks.forEach((track, i) => {
      if (removed.has(track.id)) return;
      oldToNew.set(i, tracks.length);
      positionById.set(track.id, tracks.length);
      tracks.push(byId.get(track.id) ?? track);
    });

    if (!tracks.length) {
      this.queue = { ...queue, tracks: [], index: -1, order: [], cursor: 0 };
      this._reflectQueue();
      return;
    }

    // Remap the playback order by id: removing rows must not shift `order`
    // onto the wrong tracks, and the surviving players keep their sequence.
    const order = queue.order.filter((i) => oldToNew.has(i)).map((i) => oldToNew.get(i));
    let index;
    let cursor;
    if (currentId && positionById.has(currentId)) {
      index = positionById.get(currentId);
      cursor = order.indexOf(index);
      if (cursor < 0) {
        cursor = Math.min(queue.cursor, order.length - 1);
        index = order[cursor];
      }
    } else {
      // The current track is gone: the next survivor in playback order takes
      // the slot, so the rest of the round is not replayed from the top.
      cursor = Math.min(queue.cursor, order.length - 1);
      index = order[cursor];
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
    if (next.demoUrl) {
      this.log('prefetch', { id: next.id, ok: false, skipped: 'demo' });
      return;
    }
    if (isRemoteTrack(next)) {
      // Remote sources fetch a whole file per read; eager prefetch would
      // double the network traffic for tracks that may never play.
      this.log('prefetch', { id: next.id, ok: false, skipped: 'remote' });
      return;
    }
    const result = await this.prefetcher.prime(next);
    this.log('prefetch', { id: next.id, ok: Boolean(result) });
  }

  _applyPendingSeek() {
    if (this._pendingSeek == null) return;
    this.player.seek(this._pendingSeek);
    this._state.current.position = this._pendingSeek;
    this._pendingSeek = null;
  }

  async _loadTrack(
    track,
    { play = true, position = 0, source = 'user', allowRecovery = true } = {},
  ) {
    if (!track || !this.player) return false;
    this._applyDemoFade(1);
    this._loading = true;
    this._pauseAfterLoad = false;
    this._state.current.playing = Boolean(play);
    this._state.current.position = position;
    if (track.duration) this._state.current.duration = track.duration;
    this._pendingSeek = position > 0 ? position : null;
    this._emit();
    try {
      const opened = track.demoUrl
        ? { url: track.demoUrl }
        : await (async () => {
            const adapter = this._adapterForTrack(track);
            return typeof adapter.open === 'function'
              ? adapter.open(track.path, { itemId: track.externalIds?.[track.source] ?? null })
              : { file: await adapter.getFile(track.path) };
          })();
      if (currentTrack(this.queue)?.id !== track.id) return false;
      // A blob (or a same-origin demo URL) can enter the Web Audio graph; a
      // cross-origin stream cannot, so that branch runs on a clean element.
      const blob = opened.file ?? null;
      const graphSafe = Boolean(blob) || Boolean(track.demoUrl);
      this._levelingStreaming = !graphSafe;
      if (!graphSafe) {
        if (this.player.levelingReady) await this.player.detachGraph();
      } else if (this._state.settings.leveling) {
        // Never await `resume()` here: without user activation that promise can
        // stay pending, and playback must not wait for it.
        void this._promoteLeveling();
      }
      this._syncLevelingState();
      if (opened.file) {
        await this.player.load(opened.file);
        this._loadedId = track.id;
        this._applyPendingSeek();
        if (play) await this.player.play();
        if (this._pauseAfterLoad) {
          this._pauseAfterLoad = false;
          this.player.pause();
          this._state.current.playing = false;
        }
      } else if (opened.url) {
        // The download URL plays immediately. The body keeps copying into
        // the cache; a cache failure must not cancel the song already playing.
        this.player.loadUrl(opened.url);
        this._loadedId = track.id;
        this._applyPendingSeek();
        if (play) {
          const pending = this.player.playNow();
          pending
            .then(() => {
              if (!this._pauseAfterLoad) return;
              this._pauseAfterLoad = false;
              this.player.pause();
              this._state.current.playing = false;
            })
            .catch((error) => {
              this._state.current.playing = false;
              this.log('playblocked', { error: String(error?.name ?? error) });
              this._emit();
            });
        }
        if (opened.cache && typeof opened.cache.then === 'function') {
          void opened.cache.catch((error) => {
            this.log('cache', {
              id: track.id,
              ok: false,
              error: String(error?.cause?.message ?? error?.message ?? error),
            });
          });
        }
      } else {
        throw new Error(t('error.player.missingFile'));
      }
      this.log('trackchange', { source });
      this._startPlaySession(track, this._state.current.position);
      void this._applyGainForTrack(track, blob);
      void this._primeNext();
      if (this._state.permissionIssue) this._state.permissionIssue = null;
      return true;
    } catch (error) {
      this._state.current.playing = false;
      const kind = kindOfTrack(track);
      if (allowRecovery && isPermissionFailure(error)) {
        const recovered = await this._recoverPermission(kind, error);
        if (recovered) {
          if (currentTrack(this.queue)?.id !== track.id) return false;
          return this._loadTrack(track, { play, position, source, allowRecovery: false });
        }
        this._setPermissionIssue(kind);
      }
      // One unplayable file is not a source failure; the row stays clean.
      // The play log still records why.
      this.log('loadfail', {
        error: String(error?.cause?.message ?? error?.message ?? error),
      });
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
