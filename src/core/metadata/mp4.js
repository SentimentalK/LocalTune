/**
 * MP4/M4A atom parser: mvhd duration + iTunes ilst metadata.
 * Pure function over Uint8Array; Blobs are only built for embedded covers.
 */

const ATOM_NAMES = {
  TITLE: '\u00a9nam',
  ARTIST: '\u00a9ART',
  ALBUM: '\u00a9alb',
  DAY: '\u00a9day',
  TRACK: 'trkn',
  COVER: 'covr',
};

function uint32(bytes, offset) {
  return (
    ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
  );
}

function uint16(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function uint64(bytes, offset) {
  return uint32(bytes, offset) * 0x100000000 + uint32(bytes, offset + 4);
}

function ascii(bytes, offset, length) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

function readAtoms(bytes, start, end) {
  const atoms = [];
  let cursor = start;
  while (cursor + 8 <= end) {
    let size = uint32(bytes, cursor);
    const type = ascii(bytes, cursor + 4, 4);
    let headerSize = 8;
    if (size === 1) {
      if (cursor + 16 > end) break;
      size = uint64(bytes, cursor + 8);
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

function cleanText(bytes, start, end, encoding) {
  if (start >= end) return '';
  let text = '';
  try {
    text =
      encoding === 2
        ? new TextDecoder('utf-16be').decode(bytes.subarray(start, end))
        : new TextDecoder('utf-8').decode(bytes.subarray(start, end));
  } catch {
    text = '';
  }
  return text.replace(/\u0000+/g, '').replace(/^[\s\u3000\ufeff]+|[\s\u3000\ufeff]+$/g, '');
}

function parseDataAtom(bytes, start, end) {
  if (start + 8 > end) return false;
  const type = uint32(bytes, start);
  const valueStart = start + 8;
  const valueEnd = end;
  if (valueStart >= valueEnd) return false;

  if (type === 1 || type === 2) {
    return { text: cleanText(bytes, valueStart, valueEnd, type) };
  }
  if (type === 13 || type === 14) {
    const mime = type === 13 ? 'image/jpeg' : 'image/png';
    return { cover: new Blob([bytes.slice(valueStart, valueEnd)], { type: mime }) };
  }
  if (type === 0) {
    return { binary: bytes.subarray(valueStart, valueEnd) };
  }
  return null;
}

function parseIlst(bytes, start, end, meta) {
  for (const entry of readAtoms(bytes, start, end)) {
    const dataAtoms = readAtoms(bytes, entry.start, entry.end).filter((atom) => atom.type === 'data');
    if (!dataAtoms.length) continue;
    const data = parseDataAtom(bytes, dataAtoms[0].start, dataAtoms[0].end);
    if (!data) continue;

    if (entry.type === ATOM_NAMES.TITLE && data.text) meta.title = data.text;
    else if (entry.type === ATOM_NAMES.ARTIST && data.text) meta.artist = data.text;
    else if (entry.type === ATOM_NAMES.ALBUM && data.text) meta.album = data.text;
    else if (entry.type === ATOM_NAMES.DAY && data.text) {
      const match = data.text.match(/(\d{4})/);
      if (match) meta.year = Number(match[1]);
    } else if (entry.type === ATOM_NAMES.TRACK && data.binary) {
      if (data.binary.length >= 4) {
        const track = uint16(data.binary, 2);
        if (track > 0) meta.trackNo = track;
      }
    } else if (entry.type === ATOM_NAMES.COVER && data.cover) {
      meta.cover = data.cover;
    }
  }
}

function parseMetaBox(bytes, start, end, meta) {
  // `meta` is a full box: 4 bytes version/flags precede the child atoms.
  if (start + 4 > end) return;
  const children = readAtoms(bytes, start + 4, end);
  const ilst = children.find((atom) => atom.type === 'ilst');
  if (ilst) parseIlst(bytes, ilst.start, ilst.end, meta);
}

function parseUdta(bytes, start, end, meta) {
  for (const atom of readAtoms(bytes, start, end)) {
    if (atom.type === 'meta') parseMetaBox(bytes, atom.start, atom.end, meta);
  }
}

function parseMvhd(bytes, start, end, meta) {
  if (start + 4 > end) return;
  const version = bytes[start];
  if (version === 1) {
    if (start + 32 > end) return;
    const timescale = uint32(bytes, start + 20);
    const duration = uint64(bytes, start + 24);
    if (timescale > 0 && duration > 0) meta.duration = duration / timescale;
  } else {
    if (start + 20 > end) return;
    const timescale = uint32(bytes, start + 12);
    const duration = uint32(bytes, start + 16);
    if (timescale > 0 && duration > 0 && duration !== 0xffffffff) {
      meta.duration = duration / timescale;
    }
  }
}

function parseMoov(bytes, start, end, meta) {
  for (const atom of readAtoms(bytes, start, end)) {
    if (atom.type === 'mvhd') parseMvhd(bytes, atom.start, atom.end, meta);
    else if (atom.type === 'udta') parseUdta(bytes, atom.start, atom.end, meta);
  }
}

/**
 * @param {Uint8Array} bytes
 * @returns {{title?:string,artist?:string,album?:string,year?:number|null,trackNo?:number|null,duration?:number,cover?:Blob|null}}
 */
export function parseMp4(bytes) {
  const meta = {};
  if (!bytes || bytes.length < 8) return meta;
  for (const atom of readAtoms(bytes, 0, bytes.length)) {
    if (atom.type === 'moov') parseMoov(bytes, atom.start, atom.end, meta);
  }
  return meta;
}
