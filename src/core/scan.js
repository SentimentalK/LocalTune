/**
 * Diff a previous library listing against a fresh scan.
 * Pure: no I/O, no state.
 */

export function diffScan(previous, entries) {
  const prevList = Array.from(previous ?? []);
  const entryList = Array.from(entries ?? []);
  const prevByPath = new Map(prevList.map((track) => [track.path, track]));

  const added = [];
  const updated = [];
  const removedIds = [];
  const seen = new Set();
  let unchanged = 0;

  for (const entry of entryList) {
    seen.add(entry.path);
    const prev = prevByPath.get(entry.path);
    if (!prev) {
      added.push(entry);
    } else if (prev.mtime !== entry.mtime || prev.size !== entry.size) {
      updated.push(entry);
    } else {
      unchanged += 1;
    }
  }

  for (const track of prevList) {
    if (!seen.has(track.path)) removedIds.push(track.id);
  }

  return { added, updated, removedIds, unchanged };
}
