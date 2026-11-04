/**
 * Lyric resolution order: sidecar `.lrc` → `.LRC` → embedded SYLT → USLT/©lyr.
 * The caller supplies `getFile`, so this module stays adapter-agnostic.
 */

import { decodeLyricsBytes, parseLrc, sidecarCandidates } from './lrc.js';
import { readEmbeddedLyrics } from './embedded.js';

const NONE = () => ({ source: 'none', lines: [], plain: '' });

function baseNameOf(path) {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return path.slice(slash + 1);
}

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

async function bytesOf(value) {
  if (!value) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value.arrayBuffer === 'function') return new Uint8Array(await value.arrayBuffer());
  return null;
}

/**
 * @param {object} options
 * @param {{path?:string}} options.track
 * @param {(path:string)=>Promise<Blob|File|Uint8Array|ArrayBuffer|ArrayBufferView>} options.getFile
 * @param {(file:File)=>Promise<{synced:Array<{time:number,text:string}>,plain:string}>} [options.readEmbedded]
 * @returns {Promise<{source:'lrc'|'lrc-plain'|'sylt'|'uslt'|'lyr'|'none',lines:Array<{time:number,text:string}>,plain:string}>}
 */
export async function resolveLyrics({ track, getFile, readEmbedded = readEmbeddedLyrics } = {}) {
  const path = typeof track?.path === 'string' ? track.path : '';
  if (!path || typeof getFile !== 'function') return NONE();

  for (const candidate of sidecarCandidates(path)) {
    try {
      const bytes = await bytesOf(await getFile(candidate));
      if (!bytes) continue;
      const parsed = parseLrc(decodeLyricsBytes(bytes));
      if (parsed.lines.length) {
        return { source: 'lrc', lines: parsed.lines, plain: parsed.plain };
      }
      if (parsed.plain) {
        return { source: 'lrc-plain', lines: [], plain: parsed.plain };
      }
    } catch {
      // Missing or unreadable sidecar: try the next candidate.
    }
  }

  try {
    const bytes = await bytesOf(await getFile(path));
    if (!bytes) return NONE();
    const name = baseNameOf(path);
    const file = new File([bytes], name);
    const embedded = await readEmbedded(file);
    const synced = Array.isArray(embedded?.synced) ? embedded.synced : [];
    if (synced.length) return { source: 'sylt', lines: synced, plain: '' };
    const plain = typeof embedded?.plain === 'string' ? embedded.plain : '';
    const ext = extensionOf(name);
    if (plain && (ext === 'mp3' || ext === 'm4a')) {
      return { source: ext === 'm4a' ? 'lyr' : 'uslt', lines: [], plain };
    }
  } catch {
    // No embedded tag or unreadable audio file.
  }
  return NONE();
}
