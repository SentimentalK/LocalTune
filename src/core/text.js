/**
 * Text normalization shared by search: full-width forms, traditional
 * characters and version/feat noise are folded so a query matches titles in
 * either script. No DOM, no storage, no network.
 */

/**
 * Traditional -> simplified table, loaded on demand. It is ~21 KB gzipped, so
 * it is kept out of the first-load bundle: `runSearch` awaits
 * `ensureNormalizer()` (which `import()`s the table into its own chunk), while
 * the synchronous normalizers still work as identity-only until then.
 */
let T2S = new Map();
let loading = null;

/**
 * Load the traditional/simplified table once. Idempotent: a loaded table
 * returns immediately and concurrent callers share one `import()`. A failed
 * load clears the cached promise so the next call retries.
 */
export async function ensureNormalizer() {
  if (T2S.size > 0) return;
  loading ??= import('./t2s-table.js').then(({ T2S_PAIRS }) => {
    const map = new Map();
    for (const pair of T2S_PAIRS.split(' ')) {
      const [traditional, simplified] = Array.from(pair);
      if (traditional && simplified) map.set(traditional, simplified);
    }
    if (!map.size) throw new Error('t2s table empty');
    T2S = map;
  });
  try {
    await loading;
  } catch (error) {
    loading = null;
    throw error;
  }
}

/** True once the table is in memory; until then normalization leaves hanzi as-is. */
export function isNormalizerLoaded() {
  return T2S.size > 0;
}

/** Bracket contents that mark a version/source annotation rather than a title. */
const VERSION_RE =
  /live|remaster|version|edit|mix|acoustic|instrumental|demo|mono|stereo|explicit|clean|radio|single|album|official|video|audio|lyric|mv|feat|ft\.|featuring|with/i;

/** Innermost bracket group; one pass per nesting level. */
const BRACKET_RE = /\(([^()（）]*)\)|（([^()（）]*)）|\[([^\[\]]*)\]|【([^【】]*)】/g;

/** Inline "feat. X" / "ft. X" / "featuring X" clause, up to a separator. */
const FEAT_CLAUSE_RE = /\b(?:featuring|feat|ft)\.?\s+[^,、/&;|)\]]*/gi;

/** A feat clause wrapped in brackets: keep the names, drop the brackets. */
const FEAT_BRACKET_RE =
  /[（(\[【]\s*(featuring|feat\.?|ft\.?)\s+([^()（）\[\]【】]*?)\s*[)）\]】]/gi;

const ARTIST_SPLIT_RE = /\s*(?:featuring|feat\.?|ft\.?|&|＆|、|,|\/)\s*/i;

const TRAILING_DASH_RE =
  /\s+[-–—]\s+(single|album|radio|live|remaster(ed)?|.*\bversion|.*\bmix)\b.*$/i;

/**
 * Trailing bare version words with no dash or bracket, e.g. "夜に駆ける
 * official". Deliberately narrow: words like "live" or "video" can be part of a
 * real title, so only unambiguous upload tags are stripped, and only when a
 * non-empty title precedes them.
 */
const TRAILING_TAG_RE =
  /\s+(?:official(?:\s+(?:music\s+)?(?:video|audio))?|lyric\s+video|mv|remaster(?:ed)?)$/i;

function toHalfWidth(text) {
  return text
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

function toSimplified(text) {
  let out = '';
  for (const ch of text) out += T2S.get(ch) ?? ch;
  return out;
}

function stripVersionBrackets(text) {
  let current = text;
  for (let pass = 0; pass < 8; pass += 1) {
    const next = current.replace(BRACKET_RE, (match, p1, p2, p3, p4) => {
      const inner = p1 ?? p2 ?? p3 ?? p4 ?? '';
      return VERSION_RE.test(inner) ? ' ' : match;
    });
    if (next === current) break;
    current = next;
  }
  return current;
}

function unwrapFeatBrackets(text) {
  return text.replace(FEAT_BRACKET_RE, (match, keyword, names) => ` ${keyword} ${names} `);
}

function collapseSpacing(text) {
  return text
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Shared normalization pipeline. `stripFeat` is off for artist strings, where
 * the collaborator list is the point: normalizeText("A feat. B") drops the
 * whole clause, while splitArtists() must still see "A" and "B".
 */
function coreNormalize(value, stripFeat) {
  if (typeof value !== 'string' || value === '') return '';
  let text = value.normalize('NFKC');
  text = toHalfWidth(text);
  text = toSimplified(text);
  text = text.toLowerCase();
  if (!stripFeat) text = unwrapFeatBrackets(text);
  text = stripVersionBrackets(text);
  if (stripFeat) text = text.replace(FEAT_CLAUSE_RE, ' ');
  text = text.replace(TRAILING_DASH_RE, '');
  for (let pass = 0; pass < 3; pass += 1) {
    const next = text.replace(TRAILING_TAG_RE, '');
    if (next === text || next.trim() === '') break;
    text = next;
  }
  return collapseSpacing(text);
}

/** Normalize a title: NFKC, half-width, traditional -> simplified, lowercase. */
export function normalizeText(value) {
  return coreNormalize(value, true);
}

/** Split a normalized artist string into unique, order-preserving names. */
export function splitArtists(value) {
  const text = coreNormalize(value, false);
  if (!text) return [];
  const seen = new Set();
  const artists = [];
  for (const part of text.split(ARTIST_SPLIT_RE)) {
    const artist = part.trim();
    if (!artist || seen.has(artist)) continue;
    seen.add(artist);
    artists.push(artist);
  }
  return artists;
}
