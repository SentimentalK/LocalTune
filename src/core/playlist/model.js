/**
 * Playlist model: plain objects in, plain objects out. No DOM, no IndexedDB,
 * no network. Image/link fields stay as strings; the UI decides how to show
 * them.
 *
 * @typedef {Object} PlaylistItem
 * @property {string} title
 * @property {string} artist
 * @property {number|null} durationMs
 * @property {string|null} matchedTrackId
 * @property {'matched'|'suspect'|'missing'} status
 * @property {('artist'|'duration')[]} reasons
 * @property {string|null} coverUrl
 *
 * @typedef {Object} Playlist
 * @property {string} id
 * @property {string} name
 * @property {'text'|'youtube'|'spotify'|'netease'|'qq'} source
 * @property {string|null} sourceUrl
 * @property {PlaylistItem[]} items
 * @property {number} createdAt
 */

import { t } from '../../i18n/index.js';
import { matchItem } from './match.js';

export const PLAYLIST_SOURCES = ['text', 'youtube', 'spotify', 'netease', 'qq'];

const STATUSES = new Set(['matched', 'suspect', 'missing']);
const REASONS = new Set(['artist', 'duration']);
const HTTP_URL_RE = /^https?:\/\//i;
const ILLEGAL_FILE_CHARS = /[/\\:*?"<>|]/g;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const MAX_FILE_NAME = 80;
const UNTITLED_KEY = 'playlists.untitled';

function textOf(value) {
  return typeof value === 'string' ? value : '';
}

function nonEmpty(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

function randomId(now) {
  const suffix = Math.floor(Math.random() * 0x1000000)
    .toString(16)
    .padStart(6, '0');
  return `pl_${now()}_${suffix}`;
}

/**
 * Fill in defaults for one row. A non-missing status without a track id is
 * demoted to 'missing': the status alone cannot guide the user anywhere.
 */
export function normalizePlaylistItem(item) {
  const source = item && typeof item === 'object' ? item : {};
  const matchedTrackId = nonEmpty(source.matchedTrackId);
  let status = STATUSES.has(source.status) ? source.status : 'missing';
  if (status !== 'missing' && !matchedTrackId) status = 'missing';
  return {
    title: textOf(source.title),
    artist: textOf(source.artist),
    durationMs: Number.isFinite(source.durationMs) ? source.durationMs : null,
    matchedTrackId,
    status,
    reasons: Array.isArray(source.reasons)
      ? source.reasons.filter((reason) => REASONS.has(reason))
      : [],
    coverUrl: nonEmpty(source.coverUrl),
  };
}

/** @returns {Playlist} */
export function normalizePlaylist(input, { now = Date.now, id } = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const clock = typeof now === 'function' ? now : Date.now;
  const name = textOf(source.name).trim();
  const sourceUrl = textOf(source.sourceUrl).trim();
  return {
    id: nonEmpty(id) ?? nonEmpty(source.id) ?? randomId(clock),
    name: name === '' ? t(UNTITLED_KEY) : name,
    source: PLAYLIST_SOURCES.includes(source.source) ? source.source : 'text',
    sourceUrl: HTTP_URL_RE.test(sourceUrl) ? sourceUrl : null,
    items: Array.isArray(source.items) ? source.items.map(normalizePlaylistItem) : [],
    createdAt: Number.isFinite(source.createdAt) ? source.createdAt : clock(),
  };
}

export function playlistCounts(playlist) {
  const counts = { matched: 0, suspect: 0, missing: 0 };
  const items = Array.isArray(playlist?.items) ? playlist.items : [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (STATUSES.has(item.status)) counts[item.status] += 1;
    else counts.missing += 1;
  }
  return counts;
}

/** Rows the user still has to fix, one per line, with a trailing newline. */
export function missingText(playlist) {
  const items = Array.isArray(playlist?.items) ? playlist.items : [];
  const lines = [];
  for (const item of items) {
    if (item?.status !== 'missing') continue;
    const title = textOf(item.title);
    const artist = textOf(item.artist);
    lines.push(artist ? `${artist} - ${title}` : title);
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

/** File-name-safe version of a playlist name; never empty. */
export function sanitizeFileName(name) {
  const cleaned = textOf(name)
    .replace(ILLEGAL_FILE_CHARS, '')
    .replace(CONTROL_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim();
  const truncated = Array.from(cleaned).slice(0, MAX_FILE_NAME).join('').trimEnd();
  return truncated === '' ? 'playlist' : truncated;
}

/**
 * `#EXTM3U` with one `#EXTINF`/path pair per matched row, in playlist order.
 * Only rows whose `matchedTrackId` still resolves are written; paths keep
 * their spaces (M3U is a plain text format, not a URL list).
 */
export function m3u8Text(playlist, tracks) {
  const byId = new Map();
  for (const track of Array.isArray(tracks) ? tracks : []) {
    if (track && typeof track.id === 'string' && !byId.has(track.id)) byId.set(track.id, track);
  }

  const items = Array.isArray(playlist?.items) ? playlist.items : [];
  const lines = ['#EXTM3U'];
  for (const item of items) {
    if (item?.status !== 'matched') continue;
    const track = byId.get(item.matchedTrackId);
    if (!track) continue;
    const duration = Number(track.duration);
    const seconds = duration > 0 ? Math.round(duration) : -1;
    const title = textOf(track.title) || textOf(item.title);
    const artist = textOf(track.artist) || textOf(item.artist);
    lines.push(`#EXTINF:${seconds},${artist ? `${artist} - ${title}` : title}`);
    lines.push(`./${textOf(track.path)}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Re-run matching for the missing rows only. Resolved rows keep their old
 * track id, status and reasons; the input playlist is never mutated.
 * `matchItem` lazily builds its traditional→simplified table, so the first
 * call can cost tens of milliseconds: keep this off the playback path.
 */
export async function rematchPlaylist(playlist, tracks, options = {}) {
  const items = Array.isArray(playlist?.items) ? playlist.items : [];
  const next = [];
  let added = 0;
  for (const item of items) {
    if (item?.status !== 'missing') {
      next.push(item);
      continue;
    }
    const match = await matchItem(item, tracks, options);
    const trackId = nonEmpty(match?.trackId);
    if (!match || match.status === 'missing' || !trackId) {
      next.push(item);
      continue;
    }
    added += 1;
    next.push({
      ...item,
      matchedTrackId: trackId,
      status: match.status,
      reasons: Array.isArray(match.reasons) ? [...match.reasons] : [],
    });
  }
  return { playlist: { ...playlist, items: next }, added };
}
