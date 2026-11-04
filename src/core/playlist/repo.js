/**
 * Storage-agnostic playlist repository. The caller injects the persistence
 * operations, so tests use a Map and the app passes the `playlists` store.
 */

import { normalizePlaylist } from './model.js';

function isValidRow(row) {
  return Boolean(row) && typeof row === 'object' && typeof row.id === 'string' && row.id !== '';
}

function createdAtOf(row) {
  return Number.isFinite(row.createdAt) ? row.createdAt : 0;
}

/** Newest first; equal timestamps by id so the order is reproducible. */
function compare(a, b) {
  const left = createdAtOf(a);
  const right = createdAtOf(b);
  if (left !== right) return right - left;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

export function createPlaylistRepo(ops) {
  return {
    /** @returns {Promise<import('./model.js').Playlist[]>} */
    async list() {
      const rows = await ops.all();
      if (!Array.isArray(rows)) return [];
      return rows.filter(isValidRow).sort(compare);
    },

    /** Normalizes before writing; resolves with the stored object. */
    async save(playlist) {
      const normalized = normalizePlaylist(playlist, { id: playlist?.id });
      await ops.put(normalized);
      return normalized;
    },

    async remove(id) {
      await ops.remove(id);
    },
  };
}
