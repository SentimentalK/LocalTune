/**
 * Library-wide substring search. Reuses the playlist matcher's normalization
 * (NFKC, full-width folding, traditional -> simplified, lowercase) so a query
 * matches titles in either script. The hanzi table stays a lazy `import()`:
 * only `runSearch` awaits it, synchronous callers see hanzi as-is.
 */

import { ensureNormalizer, normalizeText, splitArtists } from './playlist/match.js';

/** Group order doubles as result priority. */
const GROUPS = ['title', 'artist', 'album', 'fileName'];

/**
 * Query normalization. Non-strings and blank input become ''.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeQuery(value) {
  return normalizeText(value);
}

/** Basename of a track path, extension kept (e.g. `Music/夜曲.mp3` -> `夜曲.mp3`). */
function baseName(path) {
  if (typeof path !== 'string') return '';
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut === -1 ? path : path.slice(cut + 1);
}

/** Artist text: every credited name, so featured artists are searchable. */
function artistText(track) {
  return splitArtists(track.artist).join(' ');
}

/**
 * First field matching an already-normalized query.
 * @returns {'title'|'artist'|'album'|'fileName'|null}
 */
function matchGroup(track, query) {
  if (!query || !track || typeof track !== 'object') return null;
  if (normalizeText(track.title).includes(query)) return 'title';
  if (artistText(track).includes(query)) return 'artist';
  if (normalizeText(track.album).includes(query)) return 'album';
  if (normalizeText(baseName(track.path)).includes(query)) return 'fileName';
  return null;
}

/**
 * Group a single track hit: title, then artist, album, filename.
 * @param {object} track
 * @param {string} query raw or normalized query
 * @returns {'title'|'artist'|'album'|'fileName'|null}
 */
export function searchGroup(track, query) {
  return matchGroup(track, normalizeQuery(query));
}

function emptyResult() {
  return {
    items: [],
    counts: { title: 0, artist: 0, album: 0, fileName: 0 },
    total: 0,
  };
}

/**
 * Synchronous search. `total` and `counts` cover every hit; `items` keeps the
 * group priority (title -> artist -> album -> fileName), then input order, and
 * is capped by `limit`.
 *
 * @param {object[]} tracks
 * @param {string} query
 * @param {{ limit?: number }} [options]
 * @returns {{ items: { track: object, group: string }[], counts: { title: number, artist: number, album: number, fileName: number }, total: number }}
 */
export function searchTracks(tracks, query, { limit = 200 } = {}) {
  const normalized = normalizeQuery(query);
  if (!normalized) return emptyResult();

  const buckets = { title: [], artist: [], album: [], fileName: [] };
  for (const track of tracks) {
    const group = matchGroup(track, normalized);
    if (group) buckets[group].push({ track, group });
  }

  const counts = {};
  for (const group of GROUPS) counts[group] = buckets[group].length;
  const total = GROUPS.reduce((sum, group) => sum + counts[group], 0);

  const ordered = GROUPS.flatMap((group) => buckets[group]);
  const items = typeof limit === 'number' ? ordered.slice(0, Math.max(0, limit)) : ordered;

  return { items, counts, total };
}

/**
 * Await the lazy hanzi table, then search synchronously. A failed table load
 * yields an empty result instead of breaking the UI.
 *
 * @param {object[]} tracks
 * @param {string} query
 * @param {{ limit?: number }} [options]
 * @returns {Promise<{ items: { track: object, group: string }[], counts: { title: number, artist: number, album: number, fileName: number }, total: number }>}
 */
export async function runSearch(tracks, query, options = {}) {
  try {
    await ensureNormalizer();
  } catch {
    return emptyResult();
  }
  return searchTracks(tracks, query, options);
}
