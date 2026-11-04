/**
 * Pure playlist matching. Normalizes titles and artists (full-width forms,
 * traditional characters, version/feat noise), scores candidates by a token +
 * edit-distance blend and flags likely wrong-version hits by artist and
 * duration. No DOM, no storage, no network.
 */
import { T2S_PAIRS } from './t2s-table.js';

const T2S = (() => {
  const map = new Map();
  for (const pair of T2S_PAIRS.split(' ')) {
    const [traditional, simplified] = Array.from(pair);
    if (traditional && simplified) map.set(traditional, simplified);
  }
  return map;
})();

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

/** Titles carry version suffixes; normalizeText already removes them. */
export function normalizeTitle(value) {
  return normalizeText(value);
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

/** Leading artist of a credit string, or '' when there is none. */
export function normalizeArtist(value) {
  return splitArtists(value)[0] ?? '';
}

/** True when the credits share a lead artist or any collaborator. */
export function artistMatches(a, b) {
  const left = splitArtists(a);
  const right = splitArtists(b);
  if (!left.length || !right.length) return left.length === 0 && right.length === 0;
  if (left[0] === right[0]) return true;
  const rightSet = new Set(right);
  return left.some((name) => rightSet.has(name));
}

function levenshtein(a, b) {
  const left = Array.from(a);
  const right = Array.from(b);
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  let current = new Array(right.length + 1);
  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[right.length];
}

/** 0..1 blend of token Jaccard and code-point edit distance on normalized titles. */
export function similarity(a, b) {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  if (!left && !right) return 0;
  if (left === right) return 1;

  const leftTokens = new Set(left.split(' ').filter(Boolean));
  const rightTokens = new Set(right.split(' ').filter(Boolean));
  const union = new Set([...leftTokens, ...rightTokens]);
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  const jaccard = union.size ? intersection / union.size : 0;

  const distance = levenshtein(left, right);
  const length = Math.max(Array.from(left).length, Array.from(right).length);
  const editRatio = length ? 1 - distance / length : 0;

  return 0.5 * jaccard + 0.5 * editRatio;
}

function durationOf(item) {
  const value = item?.durationMs;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** Best match for one playlist item, with wrong-version suspicions. */
export function matchItem(item, tracks, options = {}) {
  const threshold = options?.threshold ?? 0.8;
  const durationToleranceMs = options?.durationToleranceMs ?? 15000;
  const source = item ?? {};
  const list = Array.isArray(tracks) ? tracks : [];

  const candidates = [];
  for (let index = 0; index < list.length; index += 1) {
    const track = list[index];
    if (!track) continue;
    const score = similarity(source.title, track.title);
    if (score >= threshold) candidates.push({ track, index, score });
  }
  if (!candidates.length) {
    return { status: 'missing', trackId: null, score: 0, reasons: [] };
  }

  const topScore = candidates.reduce((best, candidate) => Math.max(best, candidate.score), 0);
  const tied = candidates.filter((candidate) => candidate.score === topScore);
  const itemDuration = durationOf(source);

  let best = tied[0];
  if (itemDuration !== null && tied.length > 1) {
    let bestDelta = Infinity;
    for (const candidate of tied) {
      const trackDuration = Number(candidate.track.duration);
      const delta = trackDuration > 0 ? Math.abs(trackDuration * 1000 - itemDuration) : Infinity;
      if (delta < bestDelta) {
        bestDelta = delta;
        best = candidate;
      }
    }
  }

  const reasons = [];
  if (normalizeArtist(source.artist) && !artistMatches(source.artist, best.track.artist)) {
    reasons.push('artist');
  }
  const trackDuration = Number(best.track.duration);
  if (
    itemDuration !== null &&
    trackDuration > 0 &&
    Math.abs(trackDuration * 1000 - itemDuration) > durationToleranceMs
  ) {
    reasons.push('duration');
  }

  return {
    status: reasons.length ? 'suspect' : 'matched',
    trackId: best.track.id ?? null,
    score: best.score,
    reasons,
  };
}

/** Match every item in order; the result has the same length as `items`. */
export function matchPlaylist(items, tracks, options = {}) {
  const list = Array.isArray(items) ? items : [];
  return list.map((item) => matchItem(item, tracks, options));
}
