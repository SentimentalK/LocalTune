import { getMeta, setMeta } from './db.js';

/**
 * File source adapter for v1: File System Access.
 * No DOM access at module scope; the picker is read from `globalThis` when used.
 */

export const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'flac', 'ogg', 'oga', 'wav', 'webm']);

const DIR_HANDLE_KEY = 'dirHandle';

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
    if (state !== 'granted' && typeof handle.requestPermission === 'function') {
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
