/**
 * Minimal handwritten IndexedDB layer. Every operation resolves/rejects from
 * request or transaction completion; no DOM globals are touched at import time.
 */

import { t } from '../i18n/index.js';

export const DB_NAME = 'localtune';
export const DB_VERSION = 5;

export const TRACKS_STORE = 'tracks';
export const META_STORE = 'meta';
export const CACHE_INDEX_STORE = 'cacheIndex';
export const PINS_STORE = 'pins';
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
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(TRACKS_STORE)) {
        const store = db.createObjectStore(TRACKS_STORE, { keyPath: 'id' });
        store.createIndex('album', 'album', { unique: false });
        store.createIndex('artist', 'artist', { unique: false });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(CACHE_INDEX_STORE)) {
        db.createObjectStore(CACHE_INDEX_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(PINS_STORE)) {
        db.createObjectStore(PINS_STORE, { keyPath: 'id' });
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
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(t('error.db.open')));
  });
}

export function putTracks(db, tracks) {
  const list = Array.from(tracks ?? []);
  if (!list.length) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRACKS_STORE, 'readwrite');
    const store = tx.objectStore(TRACKS_STORE);
    for (const track of list) store.put(track);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error(t('error.db.writeTracks')));
    tx.onabort = () => reject(tx.error ?? new Error(t('error.db.writeTracksAborted')));
  });
}

export function deleteTracksById(db, ids) {
  const list = Array.from(ids ?? []);
  if (!list.length) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRACKS_STORE, 'readwrite');
    const store = tx.objectStore(TRACKS_STORE);
    for (const id of list) store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error(t('error.db.deleteTracks')));
    tx.onabort = () => reject(tx.error ?? new Error(t('error.db.deleteTracksAborted')));
  });
}

export function getAllTracks(db) {
  const tx = db.transaction(TRACKS_STORE, 'readonly');
  const request = tx.objectStore(TRACKS_STORE).getAll();
  return requestResult(request).then((tracks) => (Array.isArray(tracks) ? tracks : []));
}

export function putPlaylist(db, playlist) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PLAYLISTS_STORE, 'readwrite');
    tx.objectStore(PLAYLISTS_STORE).put(playlist);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error(t('error.db.writePlaylist')));
    tx.onabort = () => reject(tx.error ?? new Error(t('error.db.writePlaylist')));
  });
}

export function deletePlaylist(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PLAYLISTS_STORE, 'readwrite');
    tx.objectStore(PLAYLISTS_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error(t('error.db.deletePlaylist')));
    tx.onabort = () => reject(tx.error ?? new Error(t('error.db.deletePlaylist')));
  });
}

export function getAllPlaylists(db) {
  const tx = db.transaction(PLAYLISTS_STORE, 'readonly');
  const request = tx.objectStore(PLAYLISTS_STORE).getAll();
  return requestResult(request).then((rows) => (Array.isArray(rows) ? rows : []));
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
