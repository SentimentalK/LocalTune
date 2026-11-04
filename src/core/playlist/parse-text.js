// Pasted playlist text -> rows. Pure string handling: no DOM, no storage.

const DASH_SEPARATOR = /\s+[-–—－]\s+/;
const MMSS = /^(\d{1,2}):(\d{2})$/;
const HHMMSS = /^(\d{1,2}):(\d{2}):(\d{2})$/;
const SECONDS = /^\d+$/;

/** '3:45' | '1:02:03' | '225' -> milliseconds, anything else -> null. */
export function parseDuration(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;

  const hms = HHMMSS.exec(text);
  if (hms) {
    const minutes = Number(hms[2]);
    const seconds = Number(hms[3]);
    if (minutes >= 60 || seconds >= 60) return null;
    return Number(hms[1]) * 3600000 + minutes * 60000 + seconds * 1000;
  }

  const ms = MMSS.exec(text);
  if (ms) {
    const seconds = Number(ms[2]);
    if (seconds >= 60) return null;
    return Number(ms[1]) * 60000 + seconds * 1000;
  }

  if (SECONDS.test(text)) return Number(text) * 1000;
  return null;
}

function tidy(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function splitDash(text) {
  const match = DASH_SEPARATOR.exec(text);
  if (!match) return null;
  return [text.slice(0, match.index), text.slice(match.index + match[0].length)];
}

/** Minimal CSV: double quotes protect commas and are stripped. */
function splitCsv(line) {
  const fields = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

function parseTabRow(line) {
  const columns = line.split('\t').map((column) => column.trim());
  const [first, second = ''] = columns;
  const inner = splitDash(first);
  if (inner) {
    // 'A - B\t3:45': the tab column holds the duration.
    return {
      a: inner[0],
      b: inner[1],
      durationMs: columns.length > 1 ? parseDuration(columns[1]) : null,
      delimiter: 'tab',
    };
  }
  const third = columns.length > 2 ? parseDuration(columns[2]) : null;
  if (columns.length > 2) {
    return { a: first, b: second, durationMs: third, delimiter: 'tab' };
  }
  const durationFromSecond = parseDuration(second);
  if (durationFromSecond !== null && first !== '') {
    return { a: first, b: '', durationMs: durationFromSecond, delimiter: 'tab' };
  }
  return { a: first, b: second, durationMs: null, delimiter: 'tab' };
}

function parseCommaRow(line) {
  const fields = splitCsv(line).map((field) => field.trim());
  return {
    a: fields[0] ?? '',
    b: fields[1] ?? '',
    durationMs: fields.length > 2 ? parseDuration(fields[2]) : null,
    delimiter: 'comma',
  };
}

function parseRow(line) {
  if (line.includes('\t')) return parseTabRow(line);
  if (line.includes(',')) return parseCommaRow(line);
  const parts = splitDash(line);
  if (parts) return { a: parts[0], b: parts[1], durationMs: null, delimiter: 'dash' };
  return { a: line, b: '', durationMs: null, delimiter: 'none' };
}

function countHits(rows, knownArtists) {
  const known = new Set(
    knownArtists
      .filter((artist) => typeof artist === 'string')
      .map((artist) => artist.trim().toLowerCase())
      .filter(Boolean),
  );
  let a = 0;
  let b = 0;
  for (const row of rows) {
    if (known.has(tidy(row?.a).toLowerCase())) a += 1;
    if (known.has(tidy(row?.b).toLowerCase())) b += 1;
  }
  return { a, b };
}

/** 'artist-title' unless the second column matches more known artists. */
export function detectOrder(rows, { knownArtists = [] } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const hits = countHits(list, Array.isArray(knownArtists) ? knownArtists : []);
  return hits.b > hits.a ? 'title-artist' : 'artist-title';
}

export function parsePlaylistText(text, options = {}) {
  const knownArtists = Array.isArray(options.knownArtists) ? options.knownArtists : [];
  const lines = String(text ?? '').split('\n');
  const rows = [];
  const warnings = [];

  lines.forEach((line, index) => {
    const raw = line.replace(/\r/g, '').trim();
    if (raw === '' || raw.startsWith('#')) return;
    const parsed = parseRow(raw);
    const a = tidy(parsed.a);
    const b = tidy(parsed.b);
    if (a === '' && b === '') {
      warnings.push(`skipped:${index + 1}`);
      return;
    }
    rows.push({
      a,
      b,
      durationMs: parsed.durationMs,
      raw,
      delimiter: parsed.delimiter,
      single: parsed.delimiter === 'none',
    });
  });

  let order;
  let ambiguous = false;
  if (options.order === 'artist-title' || options.order === 'title-artist') {
    order = options.order;
  } else {
    order = detectOrder(rows, { knownArtists });
    const hits = countHits(rows, knownArtists);
    ambiguous = rows.length >= 2 && hits.a > 0 && hits.a === hits.b;
  }

  const items = rows.map((row) => {
    if (row.single) return { title: row.a, artist: '', durationMs: row.durationMs, raw: row.raw };
    const titleFirst = order === 'title-artist';
    return {
      title: titleFirst ? row.a : row.b,
      artist: titleFirst ? row.b : row.a,
      durationMs: row.durationMs,
      raw: row.raw,
    };
  });

  const kinds = new Set(rows.map((row) => row.delimiter).filter((kind) => kind !== 'none'));
  const delimiter = kinds.size === 0 ? 'none' : kinds.size === 1 ? [...kinds][0] : 'mixed';
  if (ambiguous) warnings.push('ambiguous-order');

  return { items, delimiter, order, warnings };
}
