/**
 * Pure import logic for the OPFS local source: plan which files to copy or
 * remove, then copy them into a FileSystemDirectoryHandle while keeping the
 * index in sync. No navigator/document access; unit tests use in-memory
 * directory handles.
 */

function abortError() {
  return Object.assign(new Error('import aborted'), { name: 'AbortError' });
}

function splitPath(path) {
  const segments = String(path ?? '')
    .split('/')
    .filter(Boolean);
  return { dirs: segments.slice(0, -1), name: segments[segments.length - 1] ?? '' };
}

async function directoryFor(root, segments, { create = true } = {}) {
  let dir = root;
  for (const segment of segments) {
    dir = await dir.getDirectoryHandle(segment, { create });
  }
  return dir;
}

/** Root folder name of a `webkitdirectory` selection: `Music/a/b.mp3` → `Music`. */
export function rootNameOf(files) {
  for (const file of Array.from(files ?? [])) {
    const raw = String(file?.webkitRelativePath ?? '');
    const root = raw.split('/')[0];
    if (root) return root;
  }
  return 'music';
}

/** One import entry for a picked `File`, with the root folder stripped. */
export function entryOf(file, rootName) {
  const raw = String(file?.webkitRelativePath || file?.name || '');
  const prefix = `${rootName}/`;
  return {
    path: raw.startsWith(prefix) ? raw.slice(prefix.length) : raw,
    size: Number(file?.size) || 0,
    mtime: Number(file?.lastModified) || 0,
    getFile: async () => file,
  };
}

/**
 * Compare the indexed rows with the picked entries.
 * @returns {{copies:Array<object>, removals:string[], skipped:number}}
 */
export function planImport(existingRows, entries) {
  const existing = new Map();
  for (const row of Array.from(existingRows ?? [])) {
    if (row && typeof row.path === 'string') existing.set(row.path, row);
  }

  const incoming = new Set();
  const copies = [];
  let skipped = 0;
  for (const entry of Array.from(entries ?? [])) {
    incoming.add(entry.path);
    const row = existing.get(entry.path);
    if (row && row.size === entry.size && row.mtime === entry.mtime) {
      skipped += 1;
    } else {
      copies.push(entry);
    }
  }

  const removals = [];
  for (const path of existing.keys()) {
    if (!incoming.has(path)) removals.push(path);
  }
  return { copies, removals, skipped };
}

/** Files at least this large stream in chunks instead of one whole-blob write. */
const STREAM_COPY_BYTES = 1 << 20;
/** Copies per main-thread yield; keeps a big import from monopolising a frame. */
const YIELD_EVERY = 8;

/**
 * Write one file into an open file handle. Big files stream so a 100 MB track
 * never lands as one giant allocation; small ones are a single write.
 */
async function copyInto(entry, fileHandle) {
  const file = await entry.getFile();
  const writable = await fileHandle.createWritable();
  try {
    if (Number(file?.size) >= STREAM_COPY_BYTES && typeof file?.stream === 'function') {
      for await (const chunk of file.stream()) await writable.write(chunk);
    } else {
      await writable.write(file);
    }
  } catch (error) {
    await writable.abort?.();
    throw error;
  }
  await writable.close();
}

function progressOf(phase, state) {
  return {
    phase,
    copied: state.copied,
    total: state.total,
    removed: state.removed,
    removedTotal: state.removedTotal,
    bytes: state.bytes,
    bytesTotal: state.bytesTotal,
    skipped: state.skipped,
  };
}

/**
 * Copy the missing/changed entries into `root`, drop the stale ones and keep
 * `index` in step. A completed file is indexed before the next one starts, so
 * an abort (or a crash) leaves a resumable prefix.
 *
 * @param {object} options
 * @param {object} options.root          FileSystemDirectoryHandle-shaped root
 * @param {object} options.index         createImportIndex() shape
 * @param {Array<object>} options.entries
 * @param {(progress:object)=>void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @param {()=>Promise<void>} [options.persist]
 */
export async function runImport({ root, index, entries, onProgress, signal, persist } = {}) {
  const existing = await index.all();
  if (existing.length === 0 && typeof persist === 'function') {
    await persist().catch(() => {});
  }

  const list = Array.from(entries ?? []);
  const { copies, removals, skipped } = planImport(existing, list);
  const state = {
    copied: 0,
    total: copies.length,
    removed: 0,
    removedTotal: removals.length,
    bytes: 0,
    bytesTotal: copies.reduce((sum, entry) => sum + (Number(entry.size) || 0), 0),
    skipped,
  };
  const report = (phase) => onProgress?.(progressOf(phase, state));

  for (const entry of copies) {
    if (signal?.aborted) throw abortError();
    const { dirs, name } = splitPath(entry.path);
    const dir = await directoryFor(root, dirs);
    const fileHandle = await dir.getFileHandle(name, { create: true });
    await copyInto(entry, fileHandle);
    await index.put({ path: entry.path, size: entry.size, mtime: entry.mtime });
    state.copied += 1;
    state.bytes += Number(entry.size) || 0;
    report('copy');
    // Let paint and input run between small files: no single task owns the
    // whole copy loop.
    if (state.copied % YIELD_EVERY === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  for (const path of removals) {
    const { dirs, name } = splitPath(path);
    try {
      const dir = await directoryFor(root, dirs, { create: false });
      await dir.removeEntry(name);
    } catch (error) {
      if (error?.name !== 'NotFoundError') throw error;
    }
    await index.remove(path);
    state.removed += 1;
    report('remove');
  }

  report('done');
  return { copied: state.copied, removed: state.removed, skipped, bytes: state.bytes };
}
