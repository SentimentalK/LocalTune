import { getMeta, setMeta } from './db.js';

/**
 * File source adapters: File System Access (Chrome 132+ on Android, all
 * desktop Chromium) and a `<input webkitdirectory>` fallback for browsers
 * without `showDirectoryPicker`.
 * No DOM access at module scope; the picker is read from `globalThis` when used.
 */

export const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'flac', 'ogg', 'oga', 'wav', 'webm']);

const DIR_HANDLE_KEY = 'dirHandle';
const FILE_LIST_KEY = 'fileList';

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

function isAudioFile(name) {
  return AUDIO_EXTENSIONS.has(extensionOf(name));
}

export class FsaSource {
  kind = 'fsa';
  name = '';

  #db = null;
  #root = null;
  #permission = 'none';
  #dirs = new Map();

  constructor(db = null) {
    this.#db = db;
  }

  /** @param {IDBDatabase|null} db */
  set db(db) {
    this.#db = db;
  }

  get db() {
    return this.#db;
  }

  async connect() {
    const picker = globalThis.showDirectoryPicker;
    if (typeof picker !== 'function') {
      throw new Error('浏览器不支持 File System Access');
    }
    const handle = await picker({ mode: 'read' });
    this.#root = handle;
    this.name = handle.name ?? '';
    this.#dirs = new Map();

    let state = 'granted';
    if (typeof handle.queryPermission === 'function') {
      state = await handle.queryPermission({ mode: 'read' });
    }
    // The picker's grant is not necessarily recorded as persistent. Ask once
    // inside the same click gesture; ignore SecurityError if activation was lost.
    let requested = false;
    if (typeof handle.requestPermission === 'function') {
      requested = true;
      try {
        const persistent = await handle.requestPermission({ mode: 'read' });
        if (persistent === 'granted') state = 'granted';
      } catch {
        // Keep the picker grant; the next launch's "继续使用" button will retry.
      }
    }
    if (!requested && state !== 'granted' && typeof handle.requestPermission === 'function') {
      state = await handle.requestPermission({ mode: 'read' });
    }
    this.#permission = state;
    if (state !== 'granted') throw new Error('未获得目录读取权限');

    if (this.#db) await setMeta(this.#db, DIR_HANDLE_KEY, handle);
    return handle;
  }

  async restore() {
    if (!this.#db) {
      this.#root = null;
      this.#permission = 'none';
      this.name = '';
      return 'none';
    }
    let handle = null;
    try {
      handle = await getMeta(this.#db, DIR_HANDLE_KEY);
    } catch {
      handle = null;
    }
    if (!handle || typeof handle.getFileHandle !== 'function') {
      this.#root = null;
      this.#permission = 'none';
      this.name = '';
      return 'none';
    }
    this.#root = handle;
    this.name = handle.name ?? '';
    this.#dirs = new Map();
    this.#permission =
      typeof handle.queryPermission === 'function'
        ? await handle.queryPermission({ mode: 'read' })
        : 'granted';
    return this.#permission;
  }

  permission() {
    return this.#permission;
  }

  async ensurePermission() {
    if (!this.#root) {
      this.#permission = 'none';
      return false;
    }
    if (this.#permission === 'granted') return true;
    if (typeof this.#root.queryPermission === 'function') {
      this.#permission = await this.#root.queryPermission({ mode: 'read' });
    }
    if (this.#permission === 'granted') return true;
    if (this.#permission === 'denied') return false;
    if (typeof this.#root.requestPermission === 'function') {
      this.#permission = await this.#root.requestPermission({ mode: 'read' });
    }
    return this.#permission === 'granted';
  }

  /** @returns {AsyncGenerator<{path:string,file:File,mtime:number,size:number}>} */
  async *scan() {
    if (!this.#root) throw new Error('目录未连接');
    this.#dirs = new Map();
    yield* this.#walk(this.#root, '');
  }

  async *#walk(dirHandle, prefix) {
    const subdirs = [];
    for await (const [name, handle] of dirHandle.entries()) {
      if (!name || name.startsWith('.')) continue;
      const path = prefix + name;
      if (handle.kind === 'directory') {
        this.#dirs.set(path, handle);
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

  /** Resolve a File from the cached/known root handle without prompting again. */
  async getFile(path) {
    if (!this.#root) throw new Error('目录未连接');
    const segments = String(path).split('/').filter(Boolean);
    if (!segments.length) throw new Error(`无效路径: ${path}`);
    let dir = this.#root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const key = segments.slice(0, i + 1).join('/');
      let next = this.#dirs.get(key);
      if (!next) {
        next = await dir.getDirectoryHandle(segments[i]);
        this.#dirs.set(key, next);
      }
      dir = next;
    }
    const fileHandle = await dir.getFileHandle(segments[segments.length - 1]);
    return fileHandle.getFile();
  }
}

/**
 * Fallback adapter for browsers without `showDirectoryPicker` (Android Chrome
 * < 132, non-Chromium): `<input type="file" webkitdirectory>` plus IndexedDB.
 * The selected `File` objects are structured-cloneable; cross-restart
 * readability depends on the browser and is verified by e2e/file-persistence.
 */
export class FileListSource {
  kind = 'files';
  name = '';

  #db = null;
  #files = new Map();
  #permission = 'none';

  constructor(db = null) {
    this.#db = db;
  }

  /** @param {IDBDatabase|null} db */
  set db(db) {
    this.#db = db;
  }

  get db() {
    return this.#db;
  }

  async connect() {
    if (typeof document === 'undefined') {
      throw new Error('浏览器不支持文件选择');
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.multiple = true;
    input.hidden = true;
    document.body.append(input);

    const files = await new Promise((resolve, reject) => {
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
        const error = new Error('已取消选择文件夹');
        error.name = 'AbortError';
        finish(reject, error);
      }
      input.addEventListener('change', onChange);
      input.addEventListener('cancel', onCancel);
      input.click();
    });

    const audio = files.filter((file) => isAudioFile(file.name));
    if (!audio.length) {
      const error = new Error('所选文件夹里没有音频文件');
      error.name = 'AbortError';
      throw error;
    }

    const rows = audio.map((file) => ({
      path: file.webkitRelativePath || file.name,
      file,
    }));
    this.#files = new Map(rows.map((row) => [row.path, row.file]));
    this.name = String(rows[0].path).split('/')[0];
    this.#permission = 'granted';
    if (this.#db) await setMeta(this.#db, FILE_LIST_KEY, rows);
    return this.#files;
  }

  async restore() {
    this.#files = new Map();
    this.#permission = 'none';
    this.name = '';
    if (!this.#db) return 'none';
    let rows = null;
    try {
      rows = await getMeta(this.#db, FILE_LIST_KEY);
    } catch {
      rows = null;
    }
    if (!Array.isArray(rows)) return 'none';
    for (const row of rows) {
      if (!row || typeof row.path !== 'string' || !row.file) continue;
      this.#files.set(row.path, row.file);
    }
    if (!this.#files.size) return 'none';
    this.name = String(this.#files.keys().next().value).split('/')[0];
    this.#permission = 'granted';
    return this.#permission;
  }

  permission() {
    return this.#files.size ? 'granted' : 'none';
  }

  async ensurePermission() {
    return this.permission() === 'granted';
  }

  /** @returns {AsyncGenerator<{path:string,file:File,mtime:number,size:number}>} */
  async *scan() {
    for (const [path, file] of this.#files) {
      yield { path, file, mtime: file.lastModified, size: file.size };
    }
  }

  async getFile(path) {
    const file = this.#files.get(path);
    if (!file) throw new Error(`文件不存在: ${path}`);
    return file;
  }
}

export function hasDirectoryPicker() {
  return typeof globalThis.showDirectoryPicker === 'function';
}

export function createSource(db) {
  return hasDirectoryPicker() ? new FsaSource(db) : new FileListSource(db);
}
