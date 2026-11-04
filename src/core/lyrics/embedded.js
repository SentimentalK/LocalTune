/**
 * Embedded lyric extraction for MP3 (ID3v2 USLT/SYLT) and M4A (`©lyr`).
 * Reads only the tag bytes it needs; malformed input returns an empty result.
 */

import { decodeLegacyText } from '../metadata/id3.js';

const MAX_ID3_TAG = 4 * 1024 * 1024;
const EMPTY = () => ({ synced: [], plain: '' });

function extensionOf(name) {
  const text = String(name ?? '');
  const dot = text.lastIndexOf('.');
  if (dot < 0 || dot === text.length - 1) return '';
  return text.slice(dot + 1).toLowerCase();
}

function ascii(bytes, offset, length) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

function uint16(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function uint32(bytes, offset) {
  return (
    ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
  );
}

function syncsafe(bytes, offset) {
  return (
    ((bytes[offset] & 0x7f) << 21) |
    ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) |
    (bytes[offset + 3] & 0x7f)
  );
}

function cleanText(text) {
  return text.replace(/\u0000+/g, '').replace(/^[\s\u3000\ufeff]+|[\s\u3000\ufeff]+$/g, '');
}

function decodeUtf16(bytes, start, end, label) {
  if (start >= end) return '';
  try {
    return cleanText(new TextDecoder(label).decode(bytes.subarray(start, end)));
  } catch {
    return '';
  }
}

function decodeFrameText(bytes, encoding, start, end) {
  if (start >= end) return '';
  switch (encoding) {
    case 0:
      // Encoding 0 is often really GBK/Shift_JIS in the wild.
      return decodeLegacyText(bytes.subarray(start, end));
    case 1: {
      if (end - start < 2) return '';
      const bom = uint16(bytes, start);
      // File-order FF FE is a little-endian BOM; FE FF is big-endian.
      if (bom === 0xfffe) return decodeUtf16(bytes, start + 2, end, 'utf-16le');
      if (bom === 0xfeff) return decodeUtf16(bytes, start + 2, end, 'utf-16be');
      return decodeUtf16(bytes, start, end, 'utf-16le');
    }
    case 2:
      return decodeUtf16(bytes, start, end, 'utf-16be');
    case 3:
      return cleanText(new TextDecoder('utf-8').decode(bytes.subarray(start, end)));
    default:
      return cleanText(ascii(bytes, start, end - start));
  }
}

function isTerminator(bytes, offset, width) {
  return width === 2 ? bytes[offset] === 0 && bytes[offset + 1] === 0 : bytes[offset] === 0;
}

/** Skip a NUL-terminated descriptor and return the offset just past it. */
function skipDescriptor(bytes, start, encoding) {
  const width = encoding === 1 || encoding === 2 ? 2 : 1;
  if (width === 1) {
    for (let i = start; i < bytes.length; i += 1) if (bytes[i] === 0) return i + 1;
    return -1;
  }
  for (let i = start; i + 1 < bytes.length; i += 2) {
    if (bytes[i] === 0 && bytes[i + 1] === 0) return i + 2;
  }
  return -1;
}

function parseUslt(payload) {
  if (payload.length < 4) return '';
  const encoding = payload[0];
  const start = skipDescriptor(payload, 4, encoding);
  if (start < 0) return '';
  return decodeFrameText(payload, encoding, start, payload.length);
}

function parseSylt(payload, synced) {
  if (payload.length < 6) return;
  const encoding = payload[0];
  const timestampFormat = payload[4];
  // Format 1 counts MPEG frames, which cannot be mapped without the audio
  // stream; only millisecond timestamps are usable here.
  if (timestampFormat !== 2) return;

  let cursor = skipDescriptor(payload, 6, encoding);
  if (cursor < 0) return;
  const width = encoding === 1 || encoding === 2 ? 2 : 1;

  while (cursor + width + 4 <= payload.length) {
    let end = -1;
    for (let i = cursor; i + width <= payload.length; i += width) {
      if (isTerminator(payload, i, width)) {
        end = i;
        break;
      }
    }
    if (end < 0) break;
    const stamp = end + width;
    if (stamp + 4 > payload.length) break;
    const text = decodeFrameText(payload, encoding, cursor, end);
    if (text) synced.push({ time: uint32(payload, stamp) / 1000, text });
    cursor = stamp + 4;
  }
}

function parseId3(bytes) {
  if (bytes.length < 10 || ascii(bytes, 0, 3) !== 'ID3') return EMPTY();
  const major = bytes[3];
  if (major !== 3 && major !== 4) return EMPTY();

  const size = syncsafe(bytes, 6);
  const end = Math.min(bytes.length, 10 + size);
  let cursor = 10;
  if (bytes[5] & 0x40) {
    // Extended header: v2.3 length excludes its own 4 bytes, v2.4 includes them.
    if (cursor + 4 > end) return EMPTY();
    cursor += major === 4 ? syncsafe(bytes, cursor) : uint32(bytes, cursor) + 4;
  }

  const plain = [];
  const synced = [];
  while (cursor + 10 <= end) {
    if (bytes[cursor] === 0) break; // padding
    const id = ascii(bytes, cursor, 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const frameSize = major === 4 ? syncsafe(bytes, cursor + 4) : uint32(bytes, cursor + 4);
    if (!frameSize) break;
    const start = cursor + 10;
    const stop = start + frameSize;
    if (stop > end) break;
    const formatFlags = bytes[cursor + 9];
    const compressed = major === 4 ? (formatFlags & 0x08) !== 0 : (formatFlags & 0x80) !== 0;
    if (!compressed) {
      const payload = bytes.subarray(start, stop);
      if (id === 'USLT') {
        const text = parseUslt(payload);
        if (text) plain.push(text);
      } else if (id === 'SYLT') {
        parseSylt(payload, synced);
      }
    }
    cursor = stop;
  }

  synced.sort((a, b) => a.time - b.time);
  return { synced, plain: plain.join('\n') };
}

/* ---------- MP4 ---------- */

function readAtoms(bytes, start, end) {
  const atoms = [];
  let cursor = start;
  while (cursor + 8 <= end) {
    let size = uint32(bytes, cursor);
    const type = ascii(bytes, cursor + 4, 4);
    let headerSize = 8;
    if (size === 1) {
      if (cursor + 16 > end) break;
      size = uint32(bytes, cursor + 8) * 0x100000000 + uint32(bytes, cursor + 12);
      headerSize = 16;
    } else if (size === 0) {
      size = end - cursor;
    }
    if (size < headerSize || cursor + size > end) break;
    atoms.push({ type, start: cursor + headerSize, end: cursor + size });
    cursor += size;
  }
  return atoms;
}

function parseMetaLyrics(bytes, start, end) {
  // `meta` is a full box: 4 version/flags bytes before the child atoms.
  if (start + 4 > end) return '';
  const ilst = readAtoms(bytes, start + 4, end).find((atom) => atom.type === 'ilst');
  if (!ilst) return '';
  const entry = readAtoms(bytes, ilst.start, ilst.end).find((atom) => atom.type === '\u00a9lyr');
  if (!entry) return '';
  const data = readAtoms(bytes, entry.start, entry.end).find((atom) => atom.type === 'data');
  if (!data || data.start + 8 > data.end) return '';
  try {
    const text = new TextDecoder('utf-8').decode(bytes.subarray(data.start + 8, data.end));
    return cleanText(text);
  } catch {
    return '';
  }
}

function parseMoovLyrics(bytes) {
  const children = readAtoms(bytes, 0, bytes.length);
  const udta = children.find((atom) => atom.type === 'udta');
  if (udta) {
    const meta = readAtoms(bytes, udta.start, udta.end).find((atom) => atom.type === 'meta');
    if (meta) return parseMetaLyrics(bytes, meta.start, meta.end);
  }
  const meta = children.find((atom) => atom.type === 'meta');
  return meta ? parseMetaLyrics(bytes, meta.start, meta.end) : '';
}

async function readM4aLyrics(file) {
  const total = Number(file.size) || 0;
  let cursor = 0;
  while (cursor + 8 <= total) {
    let head = null;
    try {
      head = new Uint8Array(await file.slice(cursor, cursor + 16).arrayBuffer());
    } catch {
      return '';
    }
    if (head.length < 8) break;
    let size = uint32(head, 0);
    const type = ascii(head, 4, 4);
    let headerSize = 8;
    if (size === 1) {
      if (head.length < 16) break;
      size = uint32(head, 8) * 0x100000000 + uint32(head, 12);
      headerSize = 16;
    } else if (size === 0) {
      size = total - cursor;
    }
    if (size < headerSize || cursor + size > total) break;
    if (type === 'moov') {
      try {
        const body = new Uint8Array(await file.slice(cursor + headerSize, cursor + size).arrayBuffer());
        return parseMoovLyrics(body);
      } catch {
        return '';
      }
    }
    cursor += size;
  }
  return '';
}

/* ---------- entry ---------- */

/**
 * @param {File|Blob} file with a `name` and `slice()`
 * @returns {Promise<{synced:Array<{time:number,text:string}>, plain:string}>}
 */
export async function readEmbeddedLyrics(file) {
  const ext = extensionOf(file?.name);
  if (ext !== 'mp3' && ext !== 'm4a') return EMPTY();
  if (typeof file.slice !== 'function') return EMPTY();
  try {
    if (ext === 'm4a') return { synced: [], plain: await readM4aLyrics(file) };

    let head = null;
    try {
      head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    } catch {
      return EMPTY();
    }
    if (head.length < 10 || ascii(head, 0, 3) !== 'ID3') return EMPTY();
    const tagSize = syncsafe(head, 6);
    const end = Math.min(10 + tagSize, MAX_ID3_TAG);
    let bytes = null;
    try {
      bytes = new Uint8Array(await file.slice(0, end).arrayBuffer());
    } catch {
      return EMPTY();
    }
    return parseId3(bytes);
  } catch {
    return EMPTY();
  }
}
