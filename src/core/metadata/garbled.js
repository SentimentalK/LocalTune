/**
 * Heuristics for tags that look like mojibake. Pure functions over strings; no
 * DOM, no I/O.
 */

function isHalfWidthKatakana(cp) {
  return cp >= 0xff61 && cp <= 0xff9f;
}

/**
 * @param {unknown} value
 * @returns {boolean} true when the text is suspicious enough to re-read.
 */
export function isGarbledText(value) {
  if (typeof value !== 'string' || value.length === 0) return false;

  let nonAscii = 0;
  let latin1Only = 0;
  let halfWidth = 0;
  for (const char of value) {
    const cp = char.codePointAt(0);
    if (cp === 0xfffd) return true;
    if (cp <= 0x7f) continue;
    nonAscii += 1;
    if (cp <= 0xff) latin1Only += 1;
    if (isHalfWidthKatakana(cp)) halfWidth += 1;
  }

  if (nonAscii === 0) return false;
  // Bytes reinterpreted as Latin-1: every non-ASCII code point fits one byte.
  if (latin1Only === nonAscii) return true;
  // Half-width katakana is what Chinese/Japanese bytes become when read as
  // Shift_JIS single bytes; when it dominates, the text is mojibake.
  return halfWidth / nonAscii >= 0.5;
}

/**
 * @param {object|null|undefined} track
 * @returns {boolean} true when any display field looks garbled.
 */
export function isGarbledTrack(track) {
  if (!track) return false;
  return (
    isGarbledText(track.title) ||
    isGarbledText(track.artist) ||
    isGarbledText(track.album)
  );
}
