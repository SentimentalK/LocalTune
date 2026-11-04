/**
 * Persistence of the playback snapshot and UI settings in the `meta` store.
 * Everything is awaited through the db layer; only `meta` is touched.
 */

import { getMeta, setMeta } from './db.js';
import { CACHE_LIMIT_OPTIONS, DEFAULT_CACHE_LIMIT } from './cache/audioCache.js';
import { normalizeProxyUrl } from './playlist/sources/proxy.js';

const PLAYBACK_KEY = 'playback';
const SETTINGS_KEY = 'settings';
const SAVE_DELAY = 1000;
const REPEAT_VALUES = new Set(['off', 'all', 'one']);
const LANGUAGE_VALUES = new Set(['auto', 'zh-CN', 'zh-TW', 'ja', 'en']);
const DEFAULT_LANGUAGE = 'auto';
const MAX_API_KEY = 200;

/** One list of allowed cache limits, owned by the cache module. */
export const DEFAULT_CACHE_LIMIT_BYTES = DEFAULT_CACHE_LIMIT;
export const CACHE_LIMIT_VALUES = CACHE_LIMIT_OPTIONS;

function isCacheLimit(bytes) {
  return Number.isFinite(bytes) && CACHE_LIMIT_OPTIONS.includes(bytes);
}

function cleanApiKey(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text.length > MAX_API_KEY ? '' : text;
}

function cleanProxyUrl(value) {
  return normalizeProxyUrl(value);
}

let pending = null;
let timer = null;

function cloneSnapshot(snapshot) {
  return {
    trackId: snapshot?.trackId ?? null,
    position: Number.isFinite(snapshot?.position) ? snapshot.position : 0,
    queueIds: Array.isArray(snapshot?.queueIds) ? [...snapshot.queueIds] : [],
    queueIndex: Number.isInteger(snapshot?.queueIndex) ? snapshot.queueIndex : 0,
    repeat: REPEAT_VALUES.has(snapshot?.repeat) ? snapshot.repeat : 'off',
    shuffle: Boolean(snapshot?.shuffle),
    volume: Number.isFinite(snapshot?.volume) ? Math.min(Math.max(snapshot.volume, 0), 1) : 1,
  };
}

function clearTimer() {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

async function flush() {
  clearTimer();
  if (!pending) return;
  const { db, snapshot } = pending;
  pending = null;
  await setMeta(db, PLAYBACK_KEY, snapshot);
}

export function savePlayback(db, snapshot) {
  pending = { db, snapshot: cloneSnapshot(snapshot) };
  // Keep the earliest deadline instead of resetting it: timeupdate fires ~4x/s
  // while playing, so a classic trailing debounce would never flush.
  if (timer !== null) return;
  timer = setTimeout(() => {
    void flush().catch(() => {});
  }, SAVE_DELAY);
  if (timer && typeof timer.unref === 'function') timer.unref();
}

savePlayback.flush = flush;

export async function loadPlayback(db) {
  const value = await getMeta(db, PLAYBACK_KEY);
  if (!value || typeof value !== 'object') return null;
  return {
    trackId: typeof value.trackId === 'string' ? value.trackId : null,
    position: Number.isFinite(value.position) ? value.position : 0,
    queueIds: Array.isArray(value.queueIds) ? value.queueIds.filter((id) => typeof id === 'string') : [],
    queueIndex: Number.isInteger(value.queueIndex) ? value.queueIndex : 0,
    repeat: REPEAT_VALUES.has(value.repeat) ? value.repeat : 'off',
    shuffle: Boolean(value.shuffle),
    volume: Number.isFinite(value.volume) ? Math.min(Math.max(value.volume, 0), 1) : 1,
  };
}

export async function loadSettings(db) {
  const value = await getMeta(db, SETTINGS_KEY);
  return {
    language: LANGUAGE_VALUES.has(value?.language) ? value.language : DEFAULT_LANGUAGE,
    cacheLimitBytes: isCacheLimit(value?.cacheLimitBytes)
      ? value.cacheLimitBytes
      : DEFAULT_CACHE_LIMIT_BYTES,
    youtubeApiKey: cleanApiKey(value?.youtubeApiKey),
    playlistProxyUrl: cleanProxyUrl(value?.playlistProxyUrl),
    leveling: value?.leveling === true,
    gapless: value?.gapless !== false,
  };
}

export async function saveSettings(db, settings) {
  const language = LANGUAGE_VALUES.has(settings?.language) ? settings.language : DEFAULT_LANGUAGE;
  const cacheLimitBytes = isCacheLimit(settings?.cacheLimitBytes)
    ? settings.cacheLimitBytes
    : DEFAULT_CACHE_LIMIT_BYTES;
  const stored = {
    language,
    cacheLimitBytes,
    youtubeApiKey: cleanApiKey(settings?.youtubeApiKey),
    playlistProxyUrl: cleanProxyUrl(settings?.playlistProxyUrl),
    leveling: settings?.leveling === true,
    gapless: settings?.gapless !== false,
  };
  await setMeta(db, SETTINGS_KEY, stored);
  return stored;
}
