/**
 * One-shot background migration: re-read tags for tracks whose display fields
 * look like mojibake. Pure orchestration over injected dependencies so the
 * store supplies the browser file source and metadata reader.
 */

import { isGarbledTrack } from './metadata/garbled.js';

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

  const cover = meta?.cover;
  if (cover) {
    if (cover !== next.cover) {
      next.cover = cover;
      changed = true;
    }
  }

  return { next, changed };
}

/**
 * @param {{
 *   tracks: object[],
 *   getFile: (path:string) => Promise<File|Blob>,
 *   readMetadata: (file: File|Blob) => Promise<object>,
 *   onProgress?: (progress:{done:number,total:number,changed:number,failed:number}) => void
 * }} options
 * @returns {Promise<{changed: object[], checked: number, failed: number}>}
 */
export async function migrateGarbledTracks({
  tracks,
  getFile,
  readMetadata,
  onProgress = () => {},
}) {
  const suspects = Array.from(tracks ?? []).filter(isGarbledTrack);
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
  }

  return { changed, checked: suspects.length, failed };
}
