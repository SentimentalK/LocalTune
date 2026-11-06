/**
 * One-shot background migration: re-read tags for tracks whose display fields
 * look like mojibake. Pure orchestration over injected dependencies so the
 * store supplies the browser file source and metadata reader.
 */

import { isGarbledTrack } from './metadata/garbled.js';
import { yieldToMain } from './timing.js';

/** Rows per event-loop yield: see enrichTracks. */
const YIELD_EVERY = 20;

/**
 * Bump when tag parsing output changes; drives the full local re-read.
 */
export const TAG_PARSER_VERSION = 2;

/**
 * Pick the tracks whose tags should be re-read for one source.
 *
 * Local and OPFS sources are fully re-read when the parser version moved on,
 * and only suspicious tracks otherwise. OneDrive never takes the full path:
 * listing every file is expensive, so it stays on the mojibake heuristic.
 *
 * @param {Iterable<object>|null|undefined} tracks
 * @param {{kind: string, parserVersion: number, lastParserVersion: (number|null|undefined)}} options
 * @returns {object[]} tracks that need a fresh read, in input order.
 */
export function selectRereadTargets(tracks, { kind, parserVersion, lastParserVersion }) {
  const list = Array.from(tracks ?? []);
  if (kind === 'onedrive') return list.filter(isGarbledTrack);
  if (parserVersion !== lastParserVersion) return list;
  return list.filter(isGarbledTrack);
}

/**
 * Merge freshly read metadata onto a track. Only non-empty values win; fields
 * the reader omits keep their old value.
 */
function mergeTrack(track, meta) {
  const next = { ...track };
  let changed = false;

  const text = (key) => {
    const value = meta?.[key];
    if (typeof value !== 'string' || value === '') return;
    if (value === next[key]) return;
    next[key] = value;
    changed = true;
  };
  text('title');
  text('artist');
  text('album');

  const number = (key, accept) => {
    const value = meta?.[key];
    if (!Number.isFinite(value) || !accept(value)) return;
    if (value === next[key]) return;
    next[key] = value;
    changed = true;
  };
  number('year', () => true);
  number('trackNo', () => true);
  number('duration', (value) => value > 0);

  // Covers live in their own store now: carry the Blob for this one write and
  // treat an identical `hasCover/coverSize` pair as "already known".
  const cover = meta?.cover;
  if (cover instanceof Blob) {
    const size = cover.size;
    const known = next.hasCover === true && next.coverSize === size;
    next.cover = cover;
    next.hasCover = true;
    next.coverSize = size;
    next.coverType = cover.type || next.coverType || null;
    if (!known) changed = true;
  }

  return { next, changed };
}

/**
 * @param {{
 *   tracks: object[],
 *   getFile: (path:string) => Promise<File|Blob>,
 *   readMetadata: (file: File|Blob) => Promise<object>,
 *   shouldRead?: (track: object) => boolean,
 *   onProgress?: (progress:{done:number,total:number,changed:number,failed:number}) => void
 * }} options
 * @returns {Promise<{changed: object[], checked: number, failed: number}>}
 */
export async function migrateGarbledTracks({
  tracks,
  getFile,
  readMetadata,
  shouldRead = isGarbledTrack,
  onProgress = () => {},
}) {
  const suspects = Array.from(tracks ?? []).filter(shouldRead);
  const total = suspects.length;
  const changed = [];
  let done = 0;
  let failed = 0;

  for (const track of suspects) {
    try {
      const file = await getFile(track.path);
      const meta = await readMetadata(file);
      const merged = mergeTrack(track, meta);
      if (merged.changed) changed.push(merged.next);
    } catch {
      failed += 1;
    }
    done += 1;
    onProgress({ done, total, changed: changed.length, failed });
    if (done % YIELD_EVERY === 0) await yieldToMain();
  }

  return { changed, checked: suspects.length, failed };
}
