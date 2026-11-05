/**
 * Metadata dispatcher: reads only the bytes each container needs.
 * Parsing failures are swallowed and yield `{}` so callers can fall back.
 */

import { parseId3, describeId3 } from './id3.js';
import { parseMp4 } from './mp4.js';

const ID3_PROBE_BYTES = 32 * 1024;
const MOOV_READ_LIMIT = 64 * 1024 * 1024;

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

function uint32(bytes, offset) {
  return (
    ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
  );
}

function ascii(bytes, offset, length) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

function syncsafe(bytes, offset) {
  return (
    ((bytes[offset] & 0x7f) << 21) |
    ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) |
    (bytes[offset + 3] & 0x7f)
  );
}

async function readSlice(file, start, end) {
  const slice = file.slice(start, end);
  return new Uint8Array(await slice.arrayBuffer());
}

async function readId3Chunks(file) {
  const size = file.size ?? 0;
  if (!size) return null;
  const head = await readSlice(file, 0, Math.min(size, 10));
  let tagSize = 0;
  if (head.length >= 10 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
    const footer = head[5] & 0x10 ? 10 : 0;
    tagSize = 10 + syncsafe(head, 6) + footer;
  }
  const readLength = Math.min(size, tagSize + ID3_PROBE_BYTES);
  const bytes = tagSize
    ? await readSlice(file, 0, readLength)
    : await readSlice(file, 0, Math.min(size, ID3_PROBE_BYTES));
  const tail = size >= 128 ? await readSlice(file, size - 128, size) : null;
  return { bytes, size, tail };
}

async function readId3(file) {
  const chunks = await readId3Chunks(file);
  if (!chunks) return {};
  return parseId3(chunks.bytes, {
    fileSize: chunks.size,
    ...(chunks.tail ? { tail: chunks.tail } : {}),
  });
}

async function readMp4(file) {
  const total = file.size ?? 0;
  let offset = 0;
  while (offset + 8 <= total) {
    const head = await readSlice(file, offset, Math.min(total, offset + 16));
    if (head.length < 8) break;
    let size = uint32(head, 0);
    const type = ascii(head, 4, 4);
    let headerSize = 8;
    if (size === 1) {
      if (head.length < 16) break;
      size = uint32(head, 8) * 0x100000000 + uint32(head, 12);
      headerSize = 16;
    } else if (size === 0) {
      size = total - offset;
    }
    if (size < headerSize) break;
    if (type === 'moov') {
      if (size > MOOV_READ_LIMIT) return {};
      const moov = await readSlice(file, offset, Math.min(total, offset + size));
      return parseMp4(moov);
    }
    offset += size;
  }
  return {};
}

/**
 * @param {File|Blob & {name?:string}} file
 * @returns {Promise<{title?:string,artist?:string,album?:string,year?:number|null,trackNo?:number|null,duration?:number,cover?:Blob|null}>}
 */
export async function readMetadata(file, name = file?.name ?? '') {
  try {
    if (!file || typeof file.slice !== 'function') return {};
    const ext = extensionOf(String(name ?? ''));
    if (ext === 'mp3') return await readId3(file);
    if (ext === 'm4a') return await readMp4(file);
    return {};
  } catch {
    return {};
  }
}

function chosenFields(meta) {
  return {
    title: typeof meta?.title === 'string' ? meta.title : '',
    artist: typeof meta?.artist === 'string' ? meta.artist : '',
    album: typeof meta?.album === 'string' ? meta.album : '',
  };
}

const EMPTY_DESCRIPTION = () => ({
  id3v2: null,
  id3v1: null,
  chosen: { title: '', artist: '', album: '' },
});

/**
 * Frame-level diagnostics for the tag fields the player displays. Reads the
 * same byte ranges as `readMetadata`; `chosen` is that function's final answer.
 *
 * @param {File|Blob & {name?:string}} file
 * @returns {Promise<{
 *   id3v2: {version:number,frames:Array<object>}|null,
 *   id3v1: {title:string,artist:string,album:string}|null,
 *   chosen: {title:string,artist:string,album:string}
 * }>}
 */
export async function describeTags(file) {
  if (!file || typeof file.slice !== 'function') return EMPTY_DESCRIPTION();
  const ext = extensionOf(file.name ?? '');
  if (ext === 'mp3') {
    const chunks = await readId3Chunks(file);
    const chosen = chosenFields(await readMetadata(file));
    if (!chunks) return { id3v2: null, id3v1: null, chosen };
    const described = describeId3(chunks.bytes, {
      fileSize: chunks.size,
      ...(chunks.tail ? { tail: chunks.tail } : {}),
    });
    return {
      id3v2: { version: described.version, frames: described.frames },
      id3v1: described.id3v1,
      chosen,
    };
  }
  if (ext === 'm4a') {
    return { id3v2: null, id3v1: null, chosen: chosenFields(await readMetadata(file)) };
  }
  return {
    id3v2: null,
    id3v1: null,
    chosen: { title: '', artist: '', album: '' },
  };
}
