/**
 * OPFS local source: one folder pick copies the audio files into the origin
 * private file system, so later launches need no grant and playback works
 * offline. The picker is a `<input webkitdirectory>`; nothing is read from
 * the DOM at module scope.
 *
 * Files live under `music/`; `meta.opfsRootName` remembers the picked folder
 * name and the `opfsIndex` store (see `./index.js`) remembers what was copied.
 */

import { getMeta, setMeta } from '../../db.js';
import { AUDIO_EXTENSIONS } from '../../source.js';
import { t } from '../../../i18n/index.js';
import { createImportIndex } from './index.js';
import { entryOf, rootNameOf, runImport } from './import.js';

const ROOT_DIR = 'music';
const ROOT_NAME_KEY = 'opfsRootName';

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

function isAudioFile(name) {
  return AUDIO_EXTENSIONS.has(extensionOf(String(name ?? '')));
}

/** Sidecar lyrics travel with the audio so `resolveLyrics` can read them later. */
function isLyricsFile(name) {
  return extensionOf(String(name ?? '')) === 'lrc';
}

function abortError(message) {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function splitPath(path) {
  const segments = String(path ?? '')
    .split('/')
    .filter(Boolean);
  return { dirs: segments.slice(0, -1), name: segments[segments.length - 1] ?? '' };
}

async function directoryFor(root, segments, { create = false } = {}) {
  let dir = root;
  for (const segment of segments) {
    dir = await dir.getDirectoryHandle(segment, { create });
  }
  return dir;
}

async function collectHandleEntries(dir, prefix, out) {
  for await (const [name, handle] of dir.entries()) {
    if (!name || name.startsWith('.')) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') {
      await collectHandleEntries(handle, path, out);
      continue;
    }
    if (handle.kind !== 'file' || !(isAudioFile(name) || isLyricsFile(name))) continue;
    const file = await handle.getFile();
    out.push({
      path,
      size: file.size,
      mtime: file.lastModified,
      getFile: async () => handle.getFile(),
    });
  }
}

async function measureDir(dir) {
  let bytes = 0;
  let count = 0;
  for await (const [name, handle] of dir.entries()) {
    if (!name || name.startsWith('.')) continue;
    if (handle.kind === 'directory') {
      const sub = await measureDir(handle);
      bytes += sub.bytes;
      count += sub.count;
      continue;
    }
    if (handle.kind !== 'file') continue;
    const file = await handle.getFile();
    bytes += file.size;
    count += 1;
  }
  return { bytes, count };
}

export class OpfsSource {
  kind = 'opfs';
  trackSource = 'opfs';
  mode = 'import';
  name = '';

  #db = null;
  #storage = null;
  #doc = null;
  #permission = 'none';
  #progress = null;
  #controller = null;

  constructor({ db = null, storage = null, document: doc = null } = {}) {
    this.#db = db;
    this.#storage = storage ?? globalThis.navigator?.storage ?? null;
    this.#doc = doc ?? globalThis.document ?? null;
  }

  /** @param {IDBDatabase|null} db */
  set db(db) {
    this.#db = db;
  }

  get db() {
    return this.#db;
  }

  set onProgress(fn) {
    this.#progress = typeof fn === 'function' ? fn : null;
  }

  #requireStorage() {
    const storage = this.#storage;
    if (!storage || typeof storage.getDirectory !== 'function') {
      throw new Error(t('error.source.notConnected'));
    }
    return storage;
  }

  async #root() {
    const base = await this.#requireStorage().getDirectory();
    return base.getDirectoryHandle(ROOT_DIR, { create: true });
  }

  /** Reopen the imported folder without prompting; `none` when nothing is stored. */
  async restore() {
    this.name = '';
    this.#permission = 'none';
    let root = null;
    try {
      const base = await this.#requireStorage().getDirectory();
      root = await base.getDirectoryHandle(ROOT_DIR, { create: false });
    } catch {
      return 'none';
    }
    if (!root) return 'none';

    if (this.#db) {
      try {
        const name = await getMeta(this.#db, ROOT_NAME_KEY);
        this.name = typeof name === 'string' ? name : '';
      } catch {
        this.name = '';
      }
    }

    let rows = [];
    try {
      rows = await createImportIndex(this.#db).all();
    } catch {
      rows = [];
    }
    this.#permission = rows.length > 0 ? 'granted' : 'none';
    return this.#permission;
  }

  permission() {
    return this.#permission;
  }

  /** Imported files never need a new grant. */
  async ensurePermission() {
    return this.permission() === 'granted';
  }

  /** Ask for a folder and copy its audio into OPFS. */
  async connect({ signal } = {}) {
    const doc = this.#doc;
    if (!doc || typeof doc.createElement !== 'function') {
      throw new Error(t('error.source.unsupportedPicker'));
    }

    const input = doc.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.multiple = true;
    input.hidden = true;
    (doc.body ?? doc.documentElement)?.append(input);

    let files;
    try {
      files = await new Promise((resolve, reject) => {
        const finish = (fn, value) => {
          input.removeEventListener('change', onChange);
          input.removeEventListener('cancel', onCancel);
          input.remove();
          fn(value);
        };
        function onChange() {
          finish(resolve, Array.from(input.files ?? []));
        }
        function onCancel() {
          finish(reject, abortError(t('error.source.cancelled')));
        }
        input.addEventListener('change', onChange);
        input.addEventListener('cancel', onCancel);
        input.click();
      });
    } finally {
      input.remove();
    }

    if (!files.length) throw abortError(t('error.source.noAudio'));

    this.#controller = new AbortController();
    const onExternalAbort = () => this.#controller.abort();
    if (signal) {
      if (signal.aborted) this.#controller.abort();
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    try {
      return await this.importFiles(files, { signal: this.#controller.signal });
    } finally {
      signal?.removeEventListener?.('abort', onExternalAbort);
      this.#controller = null;
    }
  }

  /** Copy an already-picked file list (tests and desktop pickers). */
  async importFiles(files, { signal } = {}) {
    const list = Array.from(files ?? []);
    const rootName = rootNameOf(list);
    const entries = list
      .filter((file) => isAudioFile(file.name) || isLyricsFile(file.name))
      .map((file) => entryOf(file, rootName));
    if (!entries.length) throw abortError(t('error.source.noAudio'));
    return this.#importEntries(entries, rootName, { signal });
  }

  /** Copy an existing directory handle, keeping paths relative to it. */
  async importHandle(dirHandle, { signal } = {}) {
    const entries = [];
    await collectHandleEntries(dirHandle, '', entries);
    if (!entries.length) throw abortError(t('error.source.noAudio'));
    return this.#importEntries(entries, dirHandle.name ?? '', { signal });
  }

  async #importEntries(entries, rootName, { signal } = {}) {
    if (!entries.some((entry) => isAudioFile(entry.path))) {
      throw abortError(t('error.source.noAudio'));
    }
    this.name = rootName;
    if (this.#db) await setMeta(this.#db, ROOT_NAME_KEY, rootName);
    const root = await this.#root();
    const summary = await runImport({
      root,
      index: createImportIndex(this.#db),
      entries,
      onProgress: this.#progress,
      signal,
      persist: () => this.#storage.persist?.(),
    });
    this.#permission = 'granted';
    return summary;
  }

  /** @returns {AsyncGenerator<{path:string,file:File,mtime:number,size:number}>} */
  async *scan() {
    const root = await this.#root();
    yield* this.#walk(root, '');
  }

  async *#walk(dir, prefix) {
    const subdirs = [];
    for await (const [name, handle] of dir.entries()) {
      if (!name || name.startsWith('.')) continue;
      const path = prefix + name;
      if (handle.kind === 'directory') {
        subdirs.push([handle, `${path}/`]);
        continue;
      }
      if (handle.kind !== 'file' || !isAudioFile(name)) continue;
      const file = await handle.getFile();
      yield { path, file, mtime: file.lastModified, size: file.size };
    }
    for (const [handle, childPrefix] of subdirs) {
      yield* this.#walk(handle, childPrefix);
    }
  }

  async getFile(path) {
    try {
      const { dirs, name } = splitPath(path);
      if (!name) throw new Error(t('error.source.fileMissing', { path }));
      const dir = await directoryFor(await this.#root(), dirs, { create: false });
      const handle = await dir.getFileHandle(name);
      return await handle.getFile();
    } catch (error) {
      throw new Error(t('error.source.fileMissing', { path }), { cause: error });
    }
  }

  /** Write a UTF-8 text file under `music/`, creating directories as needed. */
  async writeTextFile(path, text) {
    const { dirs, name } = splitPath(path);
    if (!name) throw new Error(t('error.source.invalidPath', { path }));
    const dir = await directoryFor(await this.#root(), dirs, { create: true });
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
  }

  /** Bytes and file count of the imported folder, for the storage card. */
  async usage() {
    try {
      const base = await this.#requireStorage().getDirectory();
      const root = await base.getDirectoryHandle(ROOT_DIR, { create: false });
      return await measureDir(root);
    } catch {
      return { bytes: 0, count: 0 };
    }
  }

  /** Forget the imported folder: files and index rows go away. */
  async clear() {
    const base = await this.#requireStorage().getDirectory();
    try {
      await base.removeEntry(ROOT_DIR, { recursive: true });
    } catch (error) {
      if (error?.name !== 'NotFoundError') throw error;
    }
    await createImportIndex(this.#db).clear();
    this.name = '';
    if (this.#db) await setMeta(this.#db, ROOT_NAME_KEY, null);
    this.#permission = 'none';
  }

  /**
   * Disconnect without touching the imported files: the index and the folder
   * name are dropped, so the source reports `none` until the next import.
   */
  async forget() {
    await createImportIndex(this.#db).clear();
    this.name = '';
    if (this.#db) await setMeta(this.#db, ROOT_NAME_KEY, null);
    this.#permission = 'none';
  }

  cancelImport() {
    this.#controller?.abort();
  }
}
