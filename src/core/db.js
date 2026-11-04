/**
 * Minimal handwritten IndexedDB layer. Every operation resolves/rejects from
 * request or transaction completion; no DOM globals are touched at import time.
 */

import { t } from '../i18n/index.js';

export const DB_NAME = 'localtune';
export const DB_VERSION = 1;

export const TRACKS_STORE = 'tracks';
export const META_STORE = 'meta';

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
