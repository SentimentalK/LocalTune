/**
 * Minimal handwritten IndexedDB layer. Every operation resolves/rejects from
 * request or transaction completion; no DOM globals are touched at import time.
 */

import { t } from '../i18n/index.js';

export const DB_NAME = 'localtune';
export const DB_VERSION = 6;

export const TRACKS_STORE = 'tracks';
export const COVERS_STORE = 'covers';
export const META_STORE = 'meta';
export const CACHE_INDEX_STORE = 'cacheIndex';
export const PLAYLOG_STORE = 'playlog';
export const OPFS_INDEX_STORE = 'opfsIndex';
export const PLAYLISTS_STORE = 'playlists';
export const STATS_STORE = 'stats';

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(t('error.db.request')));
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error(t('error.db.transaction')));
    tx.onabort = () => reject(tx.error ?? new Error(t('error.db.aborted')));
  });
}

export function openDb() {
  return new Promise((resolve, reject) => {
    const factory = globalThis.indexedDB;
    if (!factory) {
      reject(new Error(t('error.db.unavailable')));
      return;
    }
    const request = factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(TRACKS_STORE)) {
        const store = db.createObjectStore(TRACKS_STORE, { keyPath: 'id' });
        store.createIndex('album', 'album', { unique: false });
        store.createIndex('artist', 'artist', { unique: false });
      }
      if (!db.objectStoreNames.contains(COVERS_STORE)) {
        db.createObjectStore(COVERS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(CACHE_INDEX_STORE)) {
        db.createObjectStore(CACHE_INDEX_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(PLAYLOG_STORE)) {
        db.createObjectStore(PLAYLOG_STORE, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(OPFS_INDEX_STORE)) {
        db.createObjectStore(OPFS_INDEX_STORE, { keyPath: 'path' });
      }
      if (!db.objectStoreNames.contains(PLAYLISTS_STORE)) {
        const store = db.createObjectStore(PLAYLISTS_STORE, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(STATS_STORE)) {
        db.createObjectStore(STATS_STORE, { keyPath: 'id' });
      }

      if (event.oldVersion >= 1 && event.oldVersion < 6) {
        migrateInlineCovers(request.transaction);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(t('error.db.open')));
  });
}

/**
 * Move v5's inline `cover` Blobs into the `covers` store inside the upgrade
 * transaction, so the library and its artwork switch versions atomically.
 * A single bad row is skipped with a warning: one corrupt record must not
 * abort the whole upgrade and leave the user without a database.
 */
function migrateInlineCovers(tx) {
  const tracks = tx.objectStore(TRACKS_STORE);
  const covers = tx.objectStore(COVERS_STORE);
  const cursorRequest = tracks.openCursor();

  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) return;
    try {
      const row = cursor.value ?? {};
      const { cover, ...rest } = row;
      if (cover instanceof Blob) {
        covers.put({ id: row.id, cover });
        rest.hasCover = true;
        rest.coverSize = cover.size;
        rest.coverType = cover.type || null;
      } else {
        rest.hasCover = false;
        rest.coverSize = 0;
        rest.coverType = null;
      }
      cursor.update(rest);
    } catch (error) {
      console.warn('cover migration skipped one row', cursor.primaryKey, error);
    }
    cursor.continue();
  };
}

export function putTracks(db, tracks) {
  const list = Array.from(tracks ?? []);
  if (!list.length) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([TRACKS_STORE, COVERS_STORE], 'readwrite');
    const store = tx.objectStore(TRACKS_STORE);
    const covers = tx.objectStore(COVERS_STORE);
    for (const track of list) {
      const { cover, ...row } = track ?? {};
      if (cover instanceof Blob) {
        row.hasCover = true;
        row.coverSize = cover.size;
        row.coverType = cover.type || row.coverType || null;
        covers.put({ id: row.id, cover });
      } else if (cover === null) {
        row.hasCover = false;
        row.coverSize = 0;
        covers.delete(row.id);
      }
      store.put(row);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error(t('error.db.writeTracks')));
    tx.onabort = () => reject(tx.error ?? new Error(t('error.db.writeTracksAborted')));
  });
}

export function deleteTracksById(db, ids) {
  const list = Array.from(ids ?? []);
  if (!list.length) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([TRACKS_STORE, COVERS_STORE], 'readwrite');
    const store = tx.objectStore(TRACKS_STORE);
    const covers = tx.objectStore(COVERS_STORE);
    for (const id of list) {
      store.delete(id);
      covers.delete(id);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error(t('error.db.deleteTracks')));
    tx.onabort = () => reject(tx.error ?? new Error(t('error.db.deleteTracksAborted')));
  });
}

/** Resolve one stored cover, or null when it is missing or not a Blob. */
export function getCover(db, id) {
  if (!id) return Promise.resolve(null);
  try {
    const tx = db.transaction(COVERS_STORE, 'readonly');
    const request = tx.objectStore(COVERS_STORE).get(id);
    return requestResult(request)
      .then((row) => (row?.cover instanceof Blob ? row.cover : null))
      .catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}

/** Shallow copy of a track without its (transient) `cover` Blob. */
export function withoutCover(track) {
  const { cover, ...rest } = track ?? {};
  return rest;
}

export function getAllTracks(db) {
  const tx = db.transaction(TRACKS_STORE, 'readonly');
  const request = tx.objectStore(TRACKS_STORE).getAll();
  return requestResult(request).then((tracks) => (Array.isArray(tracks) ? tracks : []));
}

export function getMeta(db, key) {
  const tx = db.transaction(META_STORE, 'readonly');
  const request = tx.objectStore(META_STORE).get(key);
  return requestResult(request).then((row) => (row === undefined ? null : row.value));
}

export function setMeta(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readwrite');
    tx.objectStore(META_STORE).put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error(t('error.db.writeMeta')));
    tx.onabort = () => reject(tx.error ?? new Error(t('error.db.writeMetaAborted')));
  });
}

/**
 * Read-modify-write one meta key inside a single `readwrite` transaction, so
 * concurrent documents cannot interleave between the read and the write.
 * `updater(previous)` runs synchronously; returning `undefined` leaves the
 * value untouched, any other value is written.
 */
export function updateMeta(db, key, updater) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readwrite');
    const store = tx.objectStore(META_STORE);
    let previous = null;
    let value = null;
    let changed = false;
    let failure = null;

    const request = store.get(key);
    request.onsuccess = () => {
      const row = request.result;
      previous = row === undefined ? null : row.value;
      try {
        const next = updater(previous);
        if (next === undefined) {
          value = previous;
          return;
        }
        value = next;
        changed = true;
        store.put({ key, value });
      } catch (error) {
        failure = error ?? new Error(t('error.db.writeMeta'));
        try {
          tx.abort();
        } catch {
          // The transaction may already be finishing; onabort still rejects.
        }
      }
    };

    tx.oncomplete = () => {
      if (failure) reject(failure);
      else resolve({ previous, value, changed });
    };
    tx.onerror = () => reject(failure ?? tx.error ?? new Error(t('error.db.writeMeta')));
    tx.onabort = () => reject(failure ?? tx.error ?? new Error(t('error.db.writeMetaAborted')));
  });
}

export function getAllStats(db) {
  const tx = db.transaction(STATS_STORE, 'readonly');
  const request = tx.objectStore(STATS_STORE).getAll();
  return requestResult(request).then((rows) => (Array.isArray(rows) ? rows : []));
}

export function putStat(db, row) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STATS_STORE, 'readwrite');
    tx.objectStore(STATS_STORE).put(row);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error(t('error.db.writeStats')));
    tx.onabort = () => reject(tx.error ?? new Error(t('error.db.writeStats')));
  });
}

export function putStats(db, rows) {
  const list = Array.from(rows ?? []);
  if (!list.length) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STATS_STORE, 'readwrite');
    const store = tx.objectStore(STATS_STORE);
    for (const row of list) store.put(row);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error(t('error.db.writeStats')));
    tx.onabort = () => reject(tx.error ?? new Error(t('error.db.writeStats')));
  });
}

export function clearStats(db) {
  const tx = db.transaction(STATS_STORE, 'readwrite');
  tx.objectStore(STATS_STORE).clear();
  return transactionDone(tx);
}
