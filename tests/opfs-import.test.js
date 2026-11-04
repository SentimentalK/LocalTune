import test from 'node:test';
import assert from 'node:assert/strict';

import {
  entryOf,
  planImport,
  rootNameOf,
  runImport,
} from '../src/core/sources/opfs/import.js';

function notFound() {
  return Object.assign(new Error('not found'), { name: 'NotFoundError' });
}

/** In-memory FileSystemDirectoryHandle: Map<dirPath, Map<name, entry>>. */
function memoryRoot() {
  const tree = new Map();
  const dirAt = (path) => {
    if (!tree.has(path)) tree.set(path, new Map());
    return tree.get(path);
  };
  const join = (parent, name) => (parent ? `${parent}/${name}` : name);
  dirAt('');

  function dirHandle(path) {
    return {
      kind: 'directory',
      async getDirectoryHandle(name, { create = false } = {}) {
        const entry = dirAt(path).get(name);
        if (entry && entry.kind !== 'directory') throw new Error('not a directory');
        if (!entry) {
          if (!create) throw notFound();
          dirAt(path).set(name, { kind: 'directory' });
        }
        dirAt(join(path, name));
        return dirHandle(join(path, name));
      },
      async getFileHandle(name, { create = false } = {}) {
        const entry = dirAt(path).get(name);
        if (!entry) {
          if (!create) throw notFound();
          dirAt(path).set(name, { kind: 'file', blob: new Blob([]), lastModified: 0 });
        }
        return fileHandle(path, name);
      },
      async removeEntry(name) {
        if (!dirAt(path).delete(name)) throw notFound();
        tree.delete(join(path, name));
      },
    };
  }

  function fileHandle(parent, name) {
    return {
      kind: 'file',
      async getFile() {
        const entry = dirAt(parent).get(name);
        if (!entry || entry.kind !== 'file') throw notFound();
        return new File([entry.blob], name, { lastModified: entry.lastModified });
      },
      async createWritable() {
        let content = null;
        return {
          async write(value) {
            content = value;
          },
          async close() {
            dirAt(parent).set(name, {
              kind: 'file',
              blob: content,
              lastModified: Number(content?.lastModified) || 0,
            });
          },
          async abort() {},
        };
      },
    };
  }

  return { root: dirHandle('') };
}

function memoryIndex(rows = []) {
  const map = new Map(rows.map((row) => [row.path, { ...row }]));
  return {
    async all() {
      return [...map.values()].map((row) => ({ ...row }));
    },
    async put(row) {
      map.set(row.path, { path: row.path, size: row.size, mtime: row.mtime });
    },
    async remove(path) {
      map.delete(path);
    },
    async clear() {
      map.clear();
    },
  };
}

function makeEntry(path, size, mtime) {
  const name = path.split('/').at(-1);
  const file = new File([new Uint8Array(size)], name, { lastModified: mtime });
  return { path, size, mtime, getFile: async () => file };
}

async function readFile(root, path) {
  const segments = path.split('/');
  let dir = root;
  for (const segment of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(segment);
  return (await dir.getFileHandle(segments.at(-1))).getFile();
}

async function hasFile(root, path) {
  try {
    await readFile(root, path);
    return true;
  } catch (error) {
    if (error?.name === 'NotFoundError') return false;
    throw error;
  }
}

test('planImport copies new and changed files and drops missing ones', () => {
  const existing = [
    { path: 'a.mp3', size: 10, mtime: 100 },
    { path: 'b.mp3', size: 20, mtime: 200 },
    { path: 'old.mp3', size: 30, mtime: 300 },
  ];
  const entries = [
    makeEntry('a.mp3', 10, 100),
    makeEntry('b.mp3', 21, 200),
    makeEntry('c.mp3', 40, 400),
    makeEntry('d.mp3', 50, 500),
  ];

  const plan = planImport(existing, entries);
  assert.equal(plan.skipped, 1);
  assert.deepEqual(
    plan.copies.map((entry) => entry.path),
    ['b.mp3', 'c.mp3', 'd.mp3'],
  );
  assert.deepEqual(plan.removals, ['old.mp3']);
});

test('planImport treats a lone mtime change as a copy', () => {
  const plan = planImport(
    [{ path: 'a.mp3', size: 10, mtime: 100 }],
    [makeEntry('a.mp3', 10, 101)],
  );
  assert.equal(plan.skipped, 0);
  assert.deepEqual(
    plan.copies.map((entry) => entry.path),
    ['a.mp3'],
  );
  assert.deepEqual(plan.removals, []);
});

test('runImport copies files, reports progress and resumes without duplicates', async () => {
  const { root } = memoryRoot();
  const index = memoryIndex();
  const entries = [makeEntry('Album/a.mp3', 4, 10), makeEntry('Album/b.mp3', 6, 20)];
  const progress = [];

  const first = await runImport({
    root,
    index,
    entries,
    onProgress: (value) => progress.push(value),
  });
  assert.deepEqual(first, { copied: 2, removed: 0, skipped: 0, bytes: 10 });
  assert.equal((await index.all()).length, 2);
  assert.equal((await readFile(root, 'Album/a.mp3')).size, 4);
  assert.equal((await readFile(root, 'Album/b.mp3')).size, 6);
  assert.deepEqual(progress.at(-1), {
    phase: 'done',
    copied: 2,
    total: 2,
    removed: 0,
    removedTotal: 0,
    bytes: 10,
    bytesTotal: 10,
    skipped: 0,
  });

  const again = await runImport({ root, index, entries });
  assert.equal(again.copied, 0);
  assert.equal(again.skipped, 2);
});

test('runImport aborts between files and resumes the rest', async () => {
  const { root } = memoryRoot();
  const index = memoryIndex();
  const entries = [makeEntry('a.mp3', 3, 1), makeEntry('b.mp3', 5, 2)];
  const controller = new AbortController();

  await assert.rejects(
    runImport({
      root,
      index,
      entries,
      signal: controller.signal,
      onProgress: (value) => {
        if (value.copied === 1) controller.abort();
      },
    }),
    (error) => error.name === 'AbortError',
  );

  const rows = await index.all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, 'a.mp3');
  assert.equal(await hasFile(root, 'b.mp3'), false);

  const resumed = await runImport({ root, index, entries });
  assert.equal(resumed.copied, 1);
  assert.equal(resumed.skipped, 1);
  assert.equal((await index.all()).length, 2);
  assert.equal((await readFile(root, 'b.mp3')).size, 5);
});

test('runImport deletes files dropped from the source', async () => {
  const { root } = memoryRoot();
  const index = memoryIndex();
  const entries = [makeEntry('a.mp3', 3, 1), makeEntry('dir/b.mp3', 5, 2)];
  await runImport({ root, index, entries });
  assert.equal(await hasFile(root, 'dir/b.mp3'), true);

  const progress = [];
  const summary = await runImport({
    root,
    index,
    entries: [entries[0]],
    onProgress: (value) => progress.push(value),
  });
  assert.deepEqual(summary, { copied: 0, removed: 1, skipped: 1, bytes: 0 });
  assert.equal(await hasFile(root, 'dir/b.mp3'), false);
  assert.deepEqual(
    (await index.all()).map((row) => row.path),
    ['a.mp3'],
  );
  assert.equal(progress.some((value) => value.phase === 'remove' && value.removed === 1), true);
});

test('runImport asks for persistence only on the first import', async () => {
  const { root } = memoryRoot();
  const index = memoryIndex();
  let calls = 0;
  const persist = async () => {
    calls += 1;
  };
  const entries = [makeEntry('a.mp3', 1, 1)];
  await runImport({ root, index, entries, persist });
  await runImport({ root, index, entries, persist });
  assert.equal(calls, 1);
});

test('entryOf strips the root folder and falls back to the file name', () => {
  const nested = new File([new Uint8Array(3)], 'b.mp3', { lastModified: 7 });
  Object.defineProperty(nested, 'webkitRelativePath', { value: 'Music/a/b.mp3' });
  const entry = entryOf(nested, rootNameOf([nested]));
  assert.equal(entry.path, 'a/b.mp3');
  assert.equal(entry.size, 3);
  assert.equal(entry.mtime, 7);

  const flat = new File([new Uint8Array(2)], 'c.mp3');
  const plain = entryOf(flat, rootNameOf([flat]));
  assert.equal(plain.path, 'c.mp3');
  assert.equal(plain.size, 2);
});
