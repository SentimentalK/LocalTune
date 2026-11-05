/**
 * Shuffle / repeat preferences kept in localStorage so they survive a reload
 * even before the debounced IndexedDB playback snapshot is written.
 */

const KEY = 'localtune.playerPrefs';
const REPEAT_VALUES = new Set(['off', 'all', 'one']);
export const DEFAULT_PREFS = Object.freeze({ shuffle: false, repeat: 'off' });

function cleanPrefs(value) {
  return {
    shuffle: value?.shuffle === true,
    repeat: REPEAT_VALUES.has(value?.repeat) ? value.repeat : 'off',
  };
}

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Stored prefs, or `null` when nothing usable was stored. */
export function load(storage = defaultStorage()) {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_PREFS };
    return cleanPrefs(parsed);
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** Overwrite the stored prefs; storage failures never break playback. */
export function save(prefs, storage = defaultStorage()) {
  try {
    storage?.setItem(KEY, JSON.stringify(cleanPrefs(prefs)));
  } catch {
    // A blocked or full localStorage keeps the in-memory state only.
  }
}
