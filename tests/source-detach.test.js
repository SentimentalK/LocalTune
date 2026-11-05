import test from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/core/store.js';
import { OpfsSource } from '../src/core/sources/opfs/source.js';

function notFound() {
  return Object.assign(new Error('not found'), { name: 'NotFoundError' });
}

/** In-memory FileSystemDirectoryHandle with the subset the OPFS source uses. */
function memoryRoot(initial = {}) {
  const tree = new Map();
  const dirAt = (path) => {
    if (!tree.has(path)) tree.set(path, new Map());
    return tree.get(path);
  };
  const join = (parent, name) => (parent ? `${parent}/${name}` : name);

  function fileHandle(path, name) {
    return {
      kind: 'file',
      name,
      async getFile() {
        const size = dirAt(path).get(name)?.size ?? 0;
        return new Blob([new Uint8Array(size)]);
      },
    };
  }

  function dirHandle(path) {
    return {
      kind: 'directory',
      async getDirectoryHandle(name, { create = false } = {}) {
        const existing = dirAt(path).get(name);
        if (existing && existing.kind !== 'directory') throw new Error('not a directory');
        if (!existing) {
          if (!create) throw notFound();
          dirAt(path).set(name, { kind: 'directory' });
        }
        dirAt(join(path, name));
        return dirHandle(join(path, name));
      },
      async getFileHandle(name, { create = false } = {}) {
        const existing = dirAt(path).get(name);
        if (existing?.kind === 'directory') throw new Error('is a directory');
        if (!existing) {
          if (!create) throw notFound();
          dirAt(path).set(name, { kind: 'file', size: 0 });
        }
        return fileHandle(path, name);
      },
      async removeEntry(name, { recursive = false } = {}) {
        const entry = dirAt(path).get(name);
        if (!entry) throw notFound();
        if (entry.kind === 'directory' && !recursive) throw new Error('directory not empty');
        dirAt(path).delete(name);
        const prefix = `${join(path, name)}/`;
        for (const key of [...tree.keys()]) if (key.startsWith(prefix)) tree.delete(key);
      },
      async *entries() {
        for (const [name, entry] of dirAt(path)) {
          yield [name, entry.kind === 'directory' ? dirHandle(join(path, name)) : fileHandle(path, name)];
        }
      },
    };
  }

  dirAt('');
  for (const [path, size] of Object.entries(initial)) {
    const segments = path.split('/');
    const name = segments.pop();
    let parent = '';
    for (const segment of segments) {
      dirAt(parent).set(segment, { kind: 'directory' });
      parent = join(parent, segment);
      dirAt(parent);
    }
    dirAt(parent).set(name, { kind: 'file', size });
  }
  return { root: dirHandle(''), tree };
}

/** Minimal IDB double for the `meta` and `opfsIndex` stores. */
function fakeDb() {
  const stores = new Map();
  const storeOf = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const rows = stores.get(name);
    return {
      rows,
      clear() {
        rows.clear();
      },
      getAll() {
        return [...rows.values()];
      },
      get(key) {
        const request = {};
        queueMicrotask(() => {
          request.result = rows.get(key);
          request.onsuccess?.();
        });
        return request;
      },
      put(value) {
        rows.set(value.key ?? value.id ?? value.path, value);
      },
      delete(key) {
        rows.delete(key);
      },
    };
  };

  return {
    stores,
    transaction(names) {
      const list = Array.isArray(names) ? names : [names];
      const tx = {
        objectStore(name) {
          if (!list.includes(name)) throw new Error(`store ${name} not in transaction`);
          return storeOf(name);
        },
      };
      queueMicrotask(() => tx.oncomplete?.());
      return tx;
    },
  };
}

/** The slice of Store that `removeSource` touches, with no IndexedDB or DOM. */
function storeShell(adapter) {
  const calls = [];
  const shell = {
    sources: { local: adapter },
    calls,
    async _purgeSource() {
      calls.push('purge');
    },
    _refreshSource() {
      calls.push('refresh');
    },
    _emit() {},
    _savePlayback() {
      calls.push('save');
    },
  };
  shell.removeSource = Store.prototype.removeSource;
  return shell;
}

test('removing an OPFS import deletes its copies and the folder', async () => {
  const { root } = memoryRoot({ 'music/Album/a.mp3': 2048, 'music/b.mp3': 1024 });
  const storage = { async getDirectory() { return root; } };
  const source = new OpfsSource({ db: fakeDb(), storage });
  source.name = 'Imported';

  assert.deepEqual(await source.usage(), { bytes: 3072, count: 2 });

  const shell = storeShell(source);
  await shell.removeSource('local');

  assert.deepEqual(await source.usage(), { bytes: 0, count: 0 });
  await assert.rejects(root.getDirectoryHandle('music', { create: false }), {
    name: 'NotFoundError',
  });
  assert.equal(source.name, '');
  assert.deepEqual(shell.calls, ['purge', 'refresh', 'save']);
});

test('removing a referenced folder only drops the handle', async () => {
  let forgotten = 0;
  let cleared = 0;
  const source = {
    trackSource: 'fsa',
    name: 'Music',
    async forget() {
      forgotten += 1;
      this.name = '';
    },
    async clear() {
      cleared += 1;
      throw new Error('must not delete files on disk');
    },
  };

  const shell = storeShell(source);
  await shell.removeSource('local');

  assert.equal(forgotten, 1);
  assert.equal(cleared, 0);
  assert.equal(source.name, '');
});
