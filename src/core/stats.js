/**
 * Playback statistics and the three auto lists. Everything here is pure: no
 * DOM, no IndexedDB, no clock of its own — callers pass `now` and tracks in.
 *
 * A play counts once per listening session after the shorter of 30 s or half
 * the track has been heard. Position jumps above SEEK_JUMP_SECONDS are treated
 * as seeks and add nothing.
 */

export const PLAY_COUNT_SECONDS = 30;

const SEEK_JUMP_SECONDS = 5;

/** Seconds of real playback needed before a play counts. */
export function thresholdSeconds(duration) {
  return duration > 0 ? Math.min(PLAY_COUNT_SECONDS, duration / 2) : PLAY_COUNT_SECONDS;
}

/** @param {number} listened accumulated playback seconds since `start` */
export function shouldCount(listened, duration) {
  return listened >= thresholdSeconds(duration);
}

/**
 * Per-session playback accumulator. `start` begins a session, `pause`/`resume`
 * suspend it without losing what was already heard, and `update` returns
 * `{ justCounted: true }` exactly once when the threshold is crossed.
 */
export function createPlayCounter() {
  let track = null;
  let listened = 0;
  let counted = false;
  let active = false;
  let last = 0;

  function duration() {
    const value = track?.duration;
    return typeof value === 'number' && value > 0 ? value : 0;
  }

  return {
    start(nextTrack, position = 0) {
      track = nextTrack ?? null;
      listened = 0;
      counted = false;
      active = true;
      last = position;
    },

    update(position) {
      if (!active) return { justCounted: false };
      const delta = position - last;
      last = position;
      if (delta > 0 && delta <= SEEK_JUMP_SECONDS) {
        const cap = duration();
        const total = listened + delta;
        listened = cap > 0 ? Math.min(total, cap) : total;
      }
      if (!counted && shouldCount(listened, duration())) {
        counted = true;
        return { justCounted: true };
      }
      return { justCounted: false };
    },

    pause() {
      active = false;
    },

    resume(position) {
      active = true;
      last = position;
    },

    get listened() {
      return listened;
    },

    get counted() {
      return counted;
    },

    get trackId() {
      return track?.id ?? null;
    },
  };
}

/** New stats map with one play recorded for `id`; `stats` is not mutated. */
export function applyPlay(stats, { id, now }) {
  const base = stats ?? {};
  const row = base[id];
  return {
    ...base,
    [id]: {
      plays: (row?.plays ?? 0) + 1,
      lastPlayedAt: now,
      addedAt: row?.addedAt ?? now,
    },
  };
}

/**
 * Give every track without a stats row a zeroed one. Returns a new map plus the
 * ids that were added; existing rows are kept as they are.
 */
export function ensureAdded(stats, tracks, { now = Date.now(), addedAtFor = (track) => track.mtime || now } = {}) {
  const base = stats ?? {};
  const next = { ...base };
  const added = [];
  for (const track of tracks ?? []) {
    if (!track?.id || Object.hasOwn(next, track.id)) continue;
    next[track.id] = { plays: 0, lastPlayedAt: null, addedAt: addedAtFor(track) };
    added.push(track.id);
  }
  return { stats: next, added };
}

function rowOf(stats, track) {
  return stats?.[track.id] ?? {};
}

function comparePath(a, b) {
  return String(a?.path ?? '').localeCompare(String(b?.path ?? ''));
}

function limitOf(limit) {
  return Math.max(0, limit);
}

/** Newest `addedAt` first, missing added times last, path breaks ties. */
export function recentlyAdded(tracks, stats, limit = 50) {
  return Array.from(tracks ?? [])
    .sort((a, b) => (rowOf(stats, b).addedAt ?? 0) - (rowOf(stats, a).addedAt ?? 0) || comparePath(a, b))
    .slice(0, limitOf(limit));
}

/** Most played tracks only; plays, then last played, then path decide order. */
export function mostPlayed(tracks, stats, limit = 50) {
  return Array.from(tracks ?? [])
    .filter((track) => (rowOf(stats, track).plays ?? 0) > 0)
    .sort(
      (a, b) =>
        (rowOf(stats, b).plays ?? 0) - (rowOf(stats, a).plays ?? 0) ||
        (rowOf(stats, b).lastPlayedAt ?? 0) - (rowOf(stats, a).lastPlayedAt ?? 0) ||
        comparePath(a, b),
    )
    .slice(0, limitOf(limit));
}

/** Tracks with no plays, whether or not they have a stats row. */
export function neverPlayed(tracks, stats) {
  return Array.from(tracks ?? [])
    .filter((track) => (rowOf(stats, track).plays ?? 0) === 0)
    .sort(comparePath);
}
