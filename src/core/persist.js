/**
 * Persistence of the playback snapshot and UI settings in the `meta` store.
 * Everything is awaited through the db layer; only `meta` is touched.
 */

import { getMeta, setMeta } from './db.js';

const PLAYBACK_KEY = 'playback';
const SETTINGS_KEY = 'settings';
const SAVE_DELAY = 1000;
const REPEAT_VALUES = new Set(['off', 'all', 'one']);

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
    vinylSpin: typeof value?.vinylSpin === 'boolean' ? value.vinylSpin : true,
  };
}

export async function saveSettings(db, settings) {
  const vinylSpin = typeof settings?.vinylSpin === 'boolean' ? settings.vinylSpin : true;
  await setMeta(db, SETTINGS_KEY, { vinylSpin });
}
