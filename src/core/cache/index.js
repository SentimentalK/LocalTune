/**
 * IndexedDB adapters for the audio cache metadata. Both stores are created by
 * `db.js`; this module only wraps `db.transaction` so the cache logic can be
 * tested with plain objects.
 */

export const CACHE_INDEX_STORE = 'cacheIndex';
export const PINS_STORE = 'pins';

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('cache index request failed'));
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('cache index transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('cache index transaction aborted'));
  });
}

/** `{ key, source, path, size, lastAccess }` rows keyed by `key`. */
export function createCacheIndex(db) {
  return {
    async all() {
      const tx = db.transaction(CACHE_INDEX_STORE, 'readonly');
      const rows = await requestResult(tx.objectStore(CACHE_INDEX_STORE).getAll());
      return Array.isArray(rows) ? rows : [];
    },

    async put(row) {
      const tx = db.transaction(CACHE_INDEX_STORE, 'readwrite');
      tx.objectStore(CACHE_INDEX_STORE).put(row);
      await transactionDone(tx);
    },

    async deleteByKeys(keys) {
      const list = Array.from(keys ?? []);
      if (!list.length) return;
      const tx = db.transaction(CACHE_INDEX_STORE, 'readwrite');
      const store = tx.objectStore(CACHE_INDEX_STORE);
      for (const key of list) store.delete(key);
      await transactionDone(tx);
    },

    async clear() {
      const tx = db.transaction(CACHE_INDEX_STORE, 'readwrite');
      tx.objectStore(CACHE_INDEX_STORE).clear();
      await transactionDone(tx);
    },
  };
}

/** `{ id, source, path (or dir), ... }` pins keyed by `id`. */
export function createPinStore(db) {
  return {
    async all() {
      const tx = db.transaction(PINS_STORE, 'readonly');
      const rows = await requestResult(tx.objectStore(PINS_STORE).getAll());
      return Array.isArray(rows) ? rows : [];
    },

    async put(pin) {
      const tx = db.transaction(PINS_STORE, 'readwrite');
      tx.objectStore(PINS_STORE).put(pin);
      await transactionDone(tx);
    },

    async delete(id) {
      const tx = db.transaction(PINS_STORE, 'readwrite');
      tx.objectStore(PINS_STORE).delete(id);
      await transactionDone(tx);
    },
  };
}
