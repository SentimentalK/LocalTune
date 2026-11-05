/**
 * Background tag enrichment for freshly listed tracks. Pure and injectable:
 * no DOM, no store, no player. One unreadable file must never reject the batch
 * or surface as a source-level error, so every item is isolated.
 */

import { yieldToMain } from './timing.js';

/** Rows per event-loop yield. Metadata reads often resolve from cache, and a
 * pure microtask chain of 1000 of them starves paint and input. */
const YIELD_EVERY = 20;

export async function enrichTracks({
  items = [],
  readMetadata,
  makeTrack,
  onTrack,
  shouldUpdate,
  onProgress,
} = {}) {
  const list = Array.from(items ?? []);
  const total = list.length;
  let done = 0;
  let updated = 0;
  let failed = 0;

  for (const item of list) {
    try {
      if (typeof shouldUpdate === 'function' && !shouldUpdate(item)) {
        done += 1;
        if (typeof onProgress === 'function') onProgress({ done, total, updated, failed });
        continue;
      }
      const entry = item?.entry ?? item;
      const file =
        typeof entry?.readFile === 'function' ? await entry.readFile() : entry?.file;
      const meta = await readMetadata(file);
      const track = makeTrack(entry, meta);
      if (track) await onTrack(track);
      updated += 1;
    } catch {
      // A broken file keeps its placeholder row; the rest of the batch goes on.
      failed += 1;
    }
    done += 1;
    if (typeof onProgress === 'function') onProgress({ done, total, updated, failed });
    if (done % YIELD_EVERY === 0) await yieldToMain();
  }

  return { updated, failed };
}
