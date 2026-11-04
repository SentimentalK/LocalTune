/**
 * ID3v2.3 / v2.4 tag parser plus MPEG audio header probing for duration.
 * Pure functions over Uint8Array; no DOM, no I/O.
 */

const TEXT_IDS = new Map([
  ['TIT2', 'title'],
  ['TPE1', 'artist'],
  ['TALB', 'album'],
]);

const YEAR_IDS = new Set(['TYER', 'TDRC', 'TDAT']);

const MPEG1_BITRATES = {
  1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
};

const MPEG2_BITRATES = {
  1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

const SAMPLE_RATES = {
  1: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  2.5: [11025, 12000, 8000],
};

function syncsafe(bytes, offset) {
  return (
    ((bytes[offset] & 0x7f) << 21) |
    ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) |
    (bytes[offset + 3] & 0x7f)
  );
}

function uint16(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
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

function latin1(bytes, offset, end) {
  let out = '';
  for (let i = offset; i < end; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

function clean(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\u0000+/g, '')
    .replace(/^[\s\u3000\ufeff]+|[\s\u3000\ufeff]+$/g, '');
}

/** Candidate legacy labels, in preference order: ties keep the earlier one. */
const LEGACY_LABELS = ['utf-8', 'shift_jis', 'gb18030', 'big5', 'euc-kr'];

/** Share of decoded code points that are Hangul/CJK ideographs (kana counts half). */
function legacyScore(text) {
  let strong = 0;
  let kana = 0;
  let other = 0;
  for (const char of text) {
    const cp = char.codePointAt(0);
    if (cp <= 0x7f) continue;
    if (cp >= 0x3000 && cp <= 0x303f) continue; // CJK punctuation
    // Half-width katakana (U+FF61-U+FF9F) appears when Chinese bytes are read
    // single-byte by Shift_JIS, so treat it as evidence against the candidate
    // instead of neutral full-width forms.
    if (cp >= 0xff61 && cp <= 0xff9f) {
      other += 1;
      continue;
    }
    if (cp >= 0xff00 && cp <= 0xffef) continue; // fullwidth forms
    if (cp >= 0x3040 && cp <= 0x30ff) kana += 1;
    else if (
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0x3400 && cp <= 0x9fff) ||
      (cp >= 0xf900 && cp <= 0xfaff)
    ) {
      strong += 1;
    } else {
      other += 1;
    }
  }
  return (strong + kana * 0.5) / Math.max(1, strong + kana + other);
}

/**
 * Decode an ID3v2 encoding-0 text frame. Files in the wild store GBK,
 * GB18030, Shift_JIS or Big5 bytes under that byte, so try the likely
 * encodings and keep the one that looks most like CJK text.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function decodeLegacyText(bytes) {
  if (!bytes || !bytes.length) return '';
  let ascii = true;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] >= 0x80) {
      ascii = false;
      break;
    }
  }
  if (ascii) return clean(latin1(bytes, 0, bytes.length));

  let best = '';
  let bestScore = 0;
  for (const label of LEGACY_LABELS) {
    let text;
    try {
      text = new TextDecoder(label, { fatal: true }).decode(bytes);
    } catch {
      continue;
    }
    if (text.includes('\uFFFD')) continue;
    const score = legacyScore(text);
    if (score > bestScore) {
      best = text;
      bestScore = score;
    }
  }
  if (!best || bestScore < 0.5) return clean(latin1(bytes, 0, bytes.length));
  return clean(best);
}

function decodeText(bytes, offset, end, encoding) {
  if (offset >= end) return '';
  switch (encoding) {
    case 0:
      return decodeLegacyText(bytes.subarray(offset, end));
    case 1: {
      if (end - offset < 2) return '';
      const bom = uint16(bytes, offset);
      if (bom === 0xfeff) return decodeUtf16(bytes, offset + 2, end, 'utf-16le');
      if (bom === 0xfffe) return decodeUtf16(bytes, offset + 2, end, 'utf-16be');
      return decodeUtf16(bytes, offset, end, 'utf-16le');
    }
    case 2:
      return decodeUtf16(bytes, offset, end, 'utf-16be');
    case 3:
      return clean(new TextDecoder('utf-8').decode(bytes.subarray(offset, end)));
    default:
      return clean(latin1(bytes, offset, end));
  }
}

function decodeUtf16(bytes, offset, end, label) {
  let view = bytes.subarray(offset, end);
  if (view.length % 2 === 1) view = view.subarray(0, view.length - 1);
  if (!view.length) return '';
  try {
    return clean(new TextDecoder(label).decode(view));
  } catch {
    return '';
  }
}

/** Skip a zero-terminated string inside an APIC frame. */
function stringEnd(bytes, offset, end, encoding) {
  if (encoding === 1 || encoding === 2) {
    for (let i = offset; i + 1 < end; i += 2) {
      if (bytes[i] === 0 && bytes[i + 1] === 0) return i;
    }
    return end;
  }
  for (let i = offset; i < end; i += 1) {
    if (bytes[i] === 0) return i;
  }
  return end;
}

/** Every encoding-0 candidate, including the Latin-1 display fallback. */
const LEGACY_CANDIDATES = [...LEGACY_LABELS, 'latin1'];

function decodeLegacyCandidate(bytes, label) {
  if (label === 'latin1') return clean(latin1(bytes, 0, bytes.length));
  try {
    const text = new TextDecoder(label, { fatal: true }).decode(bytes);
    if (text.includes('\uFFFD')) return '';
    return clean(text);
  } catch {
    return '';
  }
}

/**
 * Encoding-0 candidates with the score the parser uses to pick one.
 * @param {Uint8Array} bytes
 * @returns {Array<{label:string,text:string,score:number}>}
 */
function legacyCandidates(bytes) {
  return LEGACY_CANDIDATES.map((label) => {
    const text = decodeLegacyCandidate(bytes, label);
    return { label, text, score: text ? legacyScore(text) : 0 };
  });
}

/**
 * Candidates for one text frame payload (after the encoding byte).
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 * @param {number} encoding
 * @returns {Array<{label:string,text:string,score:number}>}
 */
function frameCandidates(bytes, start, end, encoding) {
  if (encoding === 0) return legacyCandidates(bytes.subarray(start, end));

  let label;
  if (encoding === 1) {
    label = start + 2 <= end && uint16(bytes, start) === 0xfffe ? 'utf-16be' : 'utf-16le';
  } else if (encoding === 2) {
    label = 'utf-16be';
  } else {
    label = 'utf-8';
  }
  const text = decodeText(bytes, start, end, encoding);
  const ok = Boolean(text) && !text.includes('\uFFFD');
  return [{ label, text: ok ? text : '', score: ok ? 1 : 0 }];
}

/** Lower-case hex of bytes[start, end), space separated. */
function hexRange(bytes, start, end) {
  const out = [];
  for (let i = start; i < end; i += 1) out.push(bytes[i].toString(16).padStart(2, '0'));
  return out.join(' ');
}

/** One-line APIC summary without copying the image payload. */
function apicSummary(bytes, start, end, encoding) {
  let cursor = start + 1;
  const mimeEnd = stringEnd(bytes, cursor, end, 0);
  let mime = latin1(bytes, cursor, mimeEnd);
  cursor = Math.min(mimeEnd + 1, end);
  cursor = Math.min(cursor + 1, end); // picture type
  const descEnd = stringEnd(bytes, cursor, end, encoding);
  const descLen = encoding === 1 || encoding === 2 ? 2 : 1;
  cursor = Math.min(descEnd + descLen, end);
  if (cursor >= end) return `${mime || 'application/octet-stream'} 0 bytes`;
  if (!mime || mime === '-->') {
    if (bytes[cursor] === 0xff && bytes[cursor + 1] === 0xd8) mime = 'image/jpeg';
    else if (bytes[cursor] === 0x89 && bytes[cursor + 1] === 0x50 && bytes[cursor + 2] === 0x4e && bytes[cursor + 3] === 0x47) {
      mime = 'image/png';
    } else mime = 'application/octet-stream';
  }
  if (mime === 'image/jpg') mime = 'image/jpeg';
  return `${mime} ${end - cursor} bytes`;
}

function coverFromApic(bytes, start, end, encoding) {
  let cursor = start + 1;
  const mimeEnd = stringEnd(bytes, cursor, end, 0);
  let mime = latin1(bytes, cursor, mimeEnd);
  cursor = Math.min(mimeEnd + 1, end);
  const pictureType = bytes[cursor] ?? 0;
  cursor = Math.min(cursor + 1, end);
  const descEnd = stringEnd(bytes, cursor, end, encoding);
  const descLen = encoding === 1 || encoding === 2 ? 2 : 1;
  cursor = Math.min(descEnd + descLen, end);
  if (cursor >= end) return null;

  const data = bytes.slice(cursor, end);
  if (!data.length) return null;
  if (!mime || mime === '-->') {
    if (data[0] === 0xff && data[1] === 0xd8) mime = 'image/jpeg';
    else if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) mime = 'image/png';
    else mime = 'application/octet-stream';
  }
  if (mime === 'image/jpg') mime = 'image/jpeg';
  return new Blob([data], { type: mime });
}

function parseHeader(bytes, offset) {
  if (offset + 4 > bytes.length) return null;
  if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) return null;
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  const b3 = bytes[offset + 3];
  const versionBits = (b1 >> 3) & 0x03;
  const layerBits = (b1 >> 1) & 0x03;
  const bitrateIndex = (b2 >> 4) & 0x0f;
  const sampleRateIndex = (b2 >> 2) & 0x03;
  const padding = (b2 >> 1) & 0x01;
  const channelMode = (b3 >> 6) & 0x03;
  if (versionBits === 1 || layerBits === 0) return null;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return null;

  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
  const layer = 4 - layerBits;
  const table = version === 1 ? MPEG1_BITRATES : MPEG2_BITRATES;
  const bitrate = table[layer]?.[bitrateIndex];
  const sampleRate = SAMPLE_RATES[version]?.[sampleRateIndex];
  if (!bitrate || !sampleRate) return null;

  const samplesPerFrame = layer === 1 ? 384 : layer === 2 ? 1152 : version === 1 ? 1152 : 576;
  const frameLength =
    layer === 1
      ? Math.floor((12 * bitrate * 1000) / sampleRate + padding) * 4
      : Math.floor((samplesPerFrame / 8) * ((bitrate * 1000) / sampleRate)) + padding;

  const hasCrc = (b1 & 0x01) === 0;
  return {
    version,
    layer,
    bitrate,
    sampleRate,
    samplesPerFrame,
    frameLength,
    hasCrc,
    channelMode,
    mono: channelMode === 3,
  };
}

function findFirstFrame(bytes, from) {
  for (let i = Math.max(0, from); i + 4 <= bytes.length; i += 1) {
    const header = parseHeader(bytes, i);
    if (header) return { header, offset: i };
  }
  return null;
}

function xingFrameCount(bytes, header, frameOffset) {
  if (header.layer !== 3) return 0;
  let cursor = frameOffset + 4 + (header.hasCrc ? 2 : 0);
  const sideInfo =
    header.version === 1 ? (header.mono ? 17 : 32) : (header.mono ? 9 : 17);
  cursor += sideInfo;
  if (cursor + 8 > bytes.length) return 0;
  const tag = ascii(bytes, cursor, 4);
  if (tag !== 'Xing' && tag !== 'Info') return 0;
  const flags = uint32(bytes, cursor + 4);
  if (!(flags & 0x01) || cursor + 12 > bytes.length) return 0;
  return uint32(bytes, cursor + 8);
}

/**
 * Parse an ID3v1 tag. Accepts the final 128 bytes or a whole file buffer.
 * @param {Uint8Array} bytes
 * @returns {{title?:string,artist?:string,album?:string,year?:number}}
 */
export function parseId3v1(bytes) {
  const meta = {};
  if (!bytes || bytes.length < 128) return meta;
  const start = bytes.length - 128;
  if (ascii(bytes, start, 3) !== 'TAG') return meta;

  const field = (offset, length) => {
    const from = start + offset;
    let to = from + length;
    while (to > from && (bytes[to - 1] === 0x00 || bytes[to - 1] === 0x20)) to -= 1;
    return decodeLegacyText(bytes.subarray(from, to));
  };

  const title = field(3, 30);
  const artist = field(33, 30);
  const album = field(63, 30);
  if (title) meta.title = title;
  if (artist) meta.artist = artist;
  if (album) meta.album = album;

  const year = ascii(bytes, start + 93, 4).trim();
  if (/^\d{4}$/.test(year)) meta.year = Number(year);
  return meta;
}

/**
 * @param {Uint8Array} bytes
 * @param {{fileSize?: number, tail?: Uint8Array}} [options]
 * @returns {{title?:string,artist?:string,album?:string,year?:number|null,trackNo?:number|null,duration?:number,cover?:Blob|null}}
 */
export function parseId3(bytes, { fileSize = bytes?.byteLength ?? 0, tail } = {}) {
  const meta = {};
  if (!bytes || bytes.length < 4) return meta;

  let tagSize = 0;
  let framesStart = 0;
  let framesEnd = 0;
  let version = 0;

  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    version = bytes[3];
    const flags = bytes[5] ?? 0;
    const declared = syncsafe(bytes, 6);
    const footer = flags & 0x10 ? 10 : 0;
    tagSize = 10 + declared + footer;
    framesStart = 10;
    framesEnd = Math.min(bytes.length, 10 + declared);

    if (flags & 0x40) {
      if (version >= 4) {
        const extSize = syncsafe(bytes, 10);
        framesStart = Math.min(10 + Math.max(extSize, 6), framesEnd);
      } else {
        const extSize = uint32(bytes, 10);
        framesStart = Math.min(10 + 4 + extSize, framesEnd);
      }
    }
  }

  if (version > 0) {
    let cursor = framesStart;
    while (cursor + 10 <= framesEnd) {
      const id = ascii(bytes, cursor, 4);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const size =
        version >= 4
          ? syncsafe(bytes, cursor + 4)
          : uint32(bytes, cursor + 4);
      const frameFlags = uint16(bytes, cursor + 8);
      const compressed = version >= 4 ? frameFlags & 0x0008 : frameFlags & 0x0080;
      if (compressed) break; // compressed frames are out of scope
      let dataStart = cursor + 10;
      let dataEnd = dataStart + size;
      if (size <= 0 || dataEnd > framesEnd) break;
      if (version >= 4 && frameFlags & 0x0001) dataStart += 4; // data length indicator
      if (dataStart >= dataEnd) {
        cursor = dataEnd;
        continue;
      }
      const encoding = bytes[dataStart];

      const textKey = TEXT_IDS.get(id);
      if (textKey) {
        const value = decodeText(bytes, dataStart + 1, dataEnd, encoding);
        if (value) meta[textKey] = value;
      } else if (YEAR_IDS.has(id)) {
        const value = decodeText(bytes, dataStart + 1, dataEnd, encoding);
        const match = value.match(/\d{4}/);
        if (match) meta.year = Number(match[0]);
      } else if (id === 'TRCK') {
        const value = decodeText(bytes, dataStart + 1, dataEnd, encoding);
        const track = Number.parseInt(value.split('/')[0], 10);
        if (Number.isFinite(track) && track > 0) meta.trackNo = track;
      } else if (id === 'APIC') {
        const cover = coverFromApic(bytes, dataStart, dataEnd, encoding);
        if (cover) meta.cover = cover;
      }
      cursor = dataEnd;
    }
  }

  const frame = findFirstFrame(bytes, tagSize || 0);
  if (frame) {
    const { header, offset } = frame;
    const frames = xingFrameCount(bytes, header, offset);
    if (frames > 0) {
      meta.duration = (frames * header.samplesPerFrame) / header.sampleRate;
    } else if (fileSize > offset && header.bitrate > 0) {
      meta.duration = ((fileSize - offset) * 8) / (header.bitrate * 1000);
    }
  }

  const tailBytes = tail ?? (bytes.length >= 128 ? bytes.subarray(bytes.length - 128) : null);
  const legacy = tailBytes ? parseId3v1(tailBytes) : {};
  if (!meta.title && legacy.title) meta.title = legacy.title;
  if (!meta.artist && legacy.artist) meta.artist = legacy.artist;
  if (!meta.album && legacy.album) meta.album = legacy.album;
  if (meta.year == null && legacy.year != null) meta.year = legacy.year;
  return meta;
}

/**
 * Frame-level diagnostics for a buffer read the same way as `parseId3`.
 * Text frames (`T*`) and APIC are listed; compressed frames are skipped.
 *
 * @param {Uint8Array} bytes
 * @param {{fileSize?: number, tail?: Uint8Array}} [options]
 * @returns {{
 *   version: number,
 *   frames: Array<{id:string,encoding:number,rawHex32:string,decoded:string,
 *     candidates:Array<{label:string,text:string,score:number}>}>,
 *   id3v1: {title:string,artist:string,album:string}|null
 * }}
 */
export function describeId3(bytes, { fileSize = bytes?.byteLength ?? 0, tail } = {}) {
  void fileSize;
  const described = { version: 0, frames: [], id3v1: null };
  if (!bytes || bytes.length < 4) return described;

  let framesStart = 0;
  let framesEnd = 0;
  let version = 0;

  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    version = bytes[3];
    const flags = bytes[5] ?? 0;
    const declared = syncsafe(bytes, 6);
    framesStart = 10;
    framesEnd = Math.min(bytes.length, 10 + declared);

    if (flags & 0x40) {
      if (version >= 4) {
        const extSize = syncsafe(bytes, 10);
        framesStart = Math.min(10 + Math.max(extSize, 6), framesEnd);
      } else {
        const extSize = uint32(bytes, 10);
        framesStart = Math.min(10 + 4 + extSize, framesEnd);
      }
    }
  }

  described.version = version;

  if (version > 0) {
    let cursor = framesStart;
    while (cursor + 10 <= framesEnd) {
      const id = ascii(bytes, cursor, 4);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const size = version >= 4 ? syncsafe(bytes, cursor + 4) : uint32(bytes, cursor + 4);
      const frameFlags = uint16(bytes, cursor + 8);
      const compressed = version >= 4 ? frameFlags & 0x0008 : frameFlags & 0x0080;
      let dataStart = cursor + 10;
      const dataEnd = dataStart + size;
      if (size <= 0 || dataEnd > framesEnd) break;
      if (version >= 4 && frameFlags & 0x0001) dataStart += 4; // data length indicator
      if (compressed) {
        cursor = dataEnd;
        continue;
      }
      if (dataStart >= dataEnd) {
        cursor = dataEnd;
        continue;
      }

      if (id === 'APIC' || id.startsWith('T')) {
        const encoding = bytes[dataStart];
        const rawEnd = Math.min(dataEnd, dataStart + 32);
        if (id === 'APIC') {
          described.frames.push({
            id,
            encoding,
            rawHex32: hexRange(bytes, dataStart, rawEnd),
            decoded: apicSummary(bytes, dataStart, dataEnd, encoding),
            candidates: [],
          });
        } else {
          described.frames.push({
            id,
            encoding,
            rawHex32: hexRange(bytes, dataStart, rawEnd),
            decoded: decodeText(bytes, dataStart + 1, dataEnd, encoding),
            candidates: frameCandidates(bytes, dataStart + 1, dataEnd, encoding),
          });
        }
      }
      cursor = dataEnd;
    }
  }

  const tailBytes = tail ?? (bytes.length >= 128 ? bytes.subarray(bytes.length - 128) : null);
  if (
    tailBytes &&
    tailBytes.length >= 128 &&
    ascii(tailBytes, tailBytes.length - 128, 3) === 'TAG'
  ) {
    const legacy = parseId3v1(tailBytes);
    described.id3v1 = {
      title: legacy.title ?? '',
      artist: legacy.artist ?? '',
      album: legacy.album ?? '',
    };
  }
  return described;
}
