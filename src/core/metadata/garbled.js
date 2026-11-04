/**
 * Heuristics for tags that look like mojibake. Pure functions over strings; no
 * DOM, no I/O.
 */

function isHalfWidthKatakana(cp) {
  return cp >= 0xff61 && cp <= 0xff9f;
}

function isSwappedCodeUnit(cp) {
  if (cp < 0x100) return false;
  const low = cp & 0xff;
  if (low === 0x00) return true;                 // ASCII 来源：LE 字节对被当成 BE 读
  return low === 0x30 && (cp >> 8) >= 0x40;      // 假名来源（U+3041-U+30FF 低字节落 0x30）
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
  let swapped = 0;
  for (const char of value) {
    const cp = char.codePointAt(0);
    if (cp === 0xfffd) return true;
    if (cp <= 0x7f) continue;
    nonAscii += 1;
    if (cp <= 0xff) latin1Only += 1;
    if (isHalfWidthKatakana(cp)) halfWidth += 1;
    if (isSwappedCodeUnit(cp)) swapped += 1;
  }

  if (nonAscii === 0) return false;
  // Bytes reinterpreted as Latin-1: every non-ASCII code point fits one byte.
  if (latin1Only === nonAscii) return true;
  // Half-width katakana is what Chinese/Japanese bytes become when read as
  // Shift_JIS single bytes; when it dominates, the text is mojibake.
  if (halfWidth / nonAscii >= 0.5) return true;
  // UTF-16 code units whose two bytes were swapped (BE read as LE).
  return swapped / nonAscii >= 0.5;
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
