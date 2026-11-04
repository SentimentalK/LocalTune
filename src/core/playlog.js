/**
 * Ring-buffered playback diagnostics kept in IndexedDB. Recording is
 * best-effort by design: a full disk, a blocked upgrade or a closed database
 * must never interrupt playback, so every write path swallows its errors.
 */

import { PLAYLOG_STORE } from './db.js';

export const PLAYLOG_LIMIT = 500;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('playlog request failed'));
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('playlog transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('playlog transaction aborted'));
  });
}

export class PlayLog {
  constructor(db, { limit = PLAYLOG_LIMIT, now = () => Date.now() } = {}) {
    this.db = db ?? null;
    this.limit = limit;
    this.now = now;
  }

  /** Append one row, then keep the store within `limit` entries. */
  async record(type, detail = {}) {
    try {
      if (!this.db) return;
      const tx = this.db.transaction(PLAYLOG_STORE, 'readwrite');
      tx.objectStore(PLAYLOG_STORE).put({ t: this.now(), type, detail });
      await transactionDone(tx);
      await this.trim();
    } catch {
      // Logging must never break playback.
    }
  }

  /** Oldest-first slice of the newest `limit` rows. */
  async list({ limit = this.limit } = {}) {
    if (!this.db) return [];
    const tx = this.db.transaction(PLAYLOG_STORE, 'readonly');
    const rows = await requestResult(tx.objectStore(PLAYLOG_STORE).getAll());
    const list = (Array.isArray(rows) ? rows : [])
      .slice()
      .sort((a, b) => Number(a?.id ?? 0) - Number(b?.id ?? 0));
    const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : list.length;
    return list.slice(Math.max(0, list.length - max));
  }

  /** Delete the oldest rows above the limit. */
  async trim() {
    if (!this.db) return;
    const readTx = this.db.transaction(PLAYLOG_STORE, 'readonly');
    const keys = await requestResult(readTx.objectStore(PLAYLOG_STORE).getAllKeys());
    const excess = (Array.isArray(keys) ? keys.length : 0) - this.limit;
    if (excess <= 0) return;
    const tx = this.db.transaction(PLAYLOG_STORE, 'readwrite');
    const store = tx.objectStore(PLAYLOG_STORE);
    for (const key of keys.slice(0, excess)) store.delete(key);
    await transactionDone(tx);
  }

  async clear() {
    if (!this.db) return;
    const tx = this.db.transaction(PLAYLOG_STORE, 'readwrite');
    tx.objectStore(PLAYLOG_STORE).clear();
    await transactionDone(tx);
  }

  /** Plain-text dump for bug reports. Pure: no DB, no DOM. */
  static format(rows, { userAgent = '' } = {}) {
    const lines = ['LocalTune play log', `UA: ${userAgent}`];
    for (const row of Array.from(rows ?? [])) {
      let detail;
      try {
        detail = JSON.stringify(row?.detail ?? {});
      } catch {
        detail = undefined;
      }
      if (typeof detail !== 'string') detail = String(row?.detail);
      lines.push(`${new Date(row?.t).toISOString()} ${row?.type} ${detail}`);
    }
    return lines.join('\n');
  }
}
