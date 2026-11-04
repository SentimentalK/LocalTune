/**
 * Index of the files imported into OPFS, stored next to the library in the
 * `opfsIndex` object store. Kept separate from `db.js` so the importer owns
 * its schema; rows are `{ path, size, mtime }`.
 */

import { t } from '../../../i18n/index.js';

export const OPFS_INDEX_STORE = 'opfsIndex';

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

function requireDb(db) {
  if (!db) throw new Error(t('error.db.unavailable'));
  return db;
}

/**
 * @param {IDBDatabase|null} db
 * @returns {{all():Promise<Array<{path:string,size:number,mtime:number}>>,
 *   put(row:{path:string,size:number,mtime:number}):Promise<void>,
 *   remove(path:string):Promise<void>, clear():Promise<void>}}
 */
export function createImportIndex(db) {
  return {
    all() {
      return Promise.resolve().then(() => {
        const tx = requireDb(db).transaction(OPFS_INDEX_STORE, 'readonly');
        const request = tx.objectStore(OPFS_INDEX_STORE).getAll();
        return requestResult(request).then((rows) => (Array.isArray(rows) ? rows : []));
      });
    },

    put(row) {
      return Promise.resolve().then(() => {
        const tx = requireDb(db).transaction(OPFS_INDEX_STORE, 'readwrite');
        tx.objectStore(OPFS_INDEX_STORE).put({
          path: row.path,
          size: row.size,
          mtime: row.mtime,
        });
        return transactionDone(tx);
      });
    },

    remove(path) {
      return Promise.resolve().then(() => {
        const tx = requireDb(db).transaction(OPFS_INDEX_STORE, 'readwrite');
        tx.objectStore(OPFS_INDEX_STORE).delete(path);
        return transactionDone(tx);
      });
    },

    clear() {
      return Promise.resolve().then(() => {
        const tx = requireDb(db).transaction(OPFS_INDEX_STORE, 'readwrite');
        tx.objectStore(OPFS_INDEX_STORE).clear();
        return transactionDone(tx);
      });
    },
  };
}
