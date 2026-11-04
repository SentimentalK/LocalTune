import test from 'node:test';
import assert from 'node:assert/strict';

import { PlayLog } from '../src/core/playlog.js';

/** Minimal in-memory IndexedDB double: one store per db, autoIncrement keys. */
class FakeTx {
  constructor(db, map) {
    this.db = db;
    this.map = map;
    this.pending = 0;
    this.finished = false;
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
  }

  objectStore() {
    return new FakeStore(this, this.map);
  }

  _schedule(op) {
    const request = { result: undefined, error: null, onsuccess: null, onerror: null };
    this.pending += 1;
    Promise.resolve().then(() => {
      try {
        request.result = op();
        request.onsuccess?.({ target: request });
      } catch (error) {
        request.error = error;
        request.onerror?.({ target: request });
      }
      this.pending -= 1;
      if (this.pending === 0) Promise.resolve().then(() => this._complete());
    });
    return request;
  }

  _complete() {
    if (this.finished) return;
    this.finished = true;
    this.oncomplete?.();
  }
}

class FakeStore {
  constructor(tx, map) {
    this.tx = tx;
    this.map = map;
  }

  put(value) {
    return this.tx._schedule(() => {
      const row = { ...value };
      if (row.id == null) row.id = (this.tx.db.seq += 1);
      this.map.set(row.id, row);
      return row.id;
    });
  }

  getAll() {
    return this.tx._schedule(() =>
      [...this.map.values()].sort((a, b) => Number(a.id) - Number(b.id)),
    );
  }

  getAllKeys() {
    return this.tx._schedule(() => [...this.map.keys()].sort((a, b) => Number(a) - Number(b)));
  }

  delete(key) {
    return this.tx._schedule(() => {
      this.map.delete(key);
    });
  }

  clear() {
    return this.tx._schedule(() => {
      this.map.clear();
    });
  }
}

class FakeDb {
  constructor({ fail = false } = {}) {
    this.stores = new Map([['playlog', new Map()]]);
    this.seq = 0;
    this.fail = fail;
  }

  rows() {
    return this.stores.get('playlog');
  }

  transaction(name) {
    if (this.fail) throw new Error('db unavailable');
    const map = this.stores.get(name);
    if (!map) throw new Error(`unknown store ${name}`);
    return new FakeTx(this, map);
  }
}

test('keeps the newest 500 rows and drops the oldest 5', async () => {
  const db = new FakeDb();
  let clock = 0;
  const log = new PlayLog(db, { now: () => (clock += 1) });

  for (let i = 0; i < 505; i += 1) await log.record('step', { i });

  const rows = await log.list();
  assert.equal(rows.length, 500);
  assert.equal(rows[0].detail.i, 5);
  assert.equal(rows.at(-1).detail.i, 504);
  assert.equal(db.rows().size, 500);
  assert.deepEqual(
    rows.map((row) => row.id),
    rows.map((row) => row.id).slice().sort((a, b) => a - b),
  );
});

test('list returns oldest-first and honours an explicit limit', async () => {
  const db = new FakeDb();
  let clock = 0;
  const log = new PlayLog(db, { now: () => (clock += 100) });

  await log.record('first', { at: 1 });
  await log.record('second', { at: 2 });
  await log.record('third', { at: 3 });

  const all = await log.list();
  assert.deepEqual(all.map((row) => row.type), ['first', 'second', 'third']);
  assert.ok(all[0].t < all[1].t && all[1].t < all[2].t);

  const tail = await log.list({ limit: 2 });
  assert.deepEqual(tail.map((row) => row.type), ['second', 'third']);

  await log.clear();
  assert.deepEqual(await log.list(), []);
});

test('format emits a header, the UA and one ISO line per row', () => {
  const rows = [
    { id: 1, t: Date.UTC(2024, 0, 2, 3, 4, 5), type: 'audio:play', detail: { position: 1.5 } },
    { id: 2, t: Date.UTC(2024, 0, 2, 3, 4, 7), type: 'trackchange', detail: { source: 'auto' } },
  ];
  const lines = PlayLog.format(rows, { userAgent: 'UA/1.0 (test)' }).split('\n');
  assert.equal(lines[0], 'LocalTune play log');
  assert.equal(lines[1], 'UA: UA/1.0 (test)');
  assert.equal(lines[2], '2024-01-02T03:04:05.000Z audio:play {"position":1.5}');
  assert.equal(lines[3], '2024-01-02T03:04:07.000Z trackchange {"source":"auto"}');
});

test('format falls back to String(detail) when JSON cannot serialize', () => {
  const detail = { position: 3 };
  detail.self = detail;
  const text = PlayLog.format([{ t: 0, type: 'loop', detail }]);
  assert.match(text, /1970-01-01T00:00:00\.000Z loop \[object Object\]/);
});

test('record never rejects when the database throws', async () => {
  const db = new FakeDb({ fail: true });
  const log = new PlayLog(db);
  await assert.doesNotReject(log.record('audio:play', { position: 0 }));
});
