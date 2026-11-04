/**
 * Folder grouping for the library. Pure: no DOM, no storage, no imports.
 *
 * A track's directory is the POSIX substring before its last '/'. Every
 * directory that directly contains audio becomes an entry, and that entry
 * lists every track beneath it, descendants included.
 */

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function pathOf(track) {
  return typeof track?.path === 'string' ? track.path : '';
}

function dirOf(path) {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

function baseOf(path) {
  return path.slice(path.lastIndexOf('/') + 1);
}

function ancestors(dir) {
  if (dir === '') return [''];
  const list = [];
  let current = dir;
  while (current) {
    list.push(current);
    const slash = current.lastIndexOf('/');
    current = slash < 0 ? '' : current.slice(0, slash);
  }
  return list;
}

function trackOrder(track) {
  const value = track?.trackNo;
  return Number.isInteger(value) && value > 0 ? value : null;
}

function compareTracks(a, b) {
  const left = trackOrder(a);
  const right = trackOrder(b);
  if (left !== right) {
    if (left === null) return 1;
    if (right === null) return -1;
    return left - right;
  }
  const byBase = collator.compare(baseOf(pathOf(a)), baseOf(pathOf(b)));
  if (byBase !== 0) return byBase;
  return pathOf(a).localeCompare(pathOf(b));
}

export function groupByFolder(tracks = []) {
  const list = Array.from(tracks ?? []);
  if (!list.length) return [];

  const direct = new Set();
  for (const track of list) direct.add(dirOf(pathOf(track)));

  const buckets = new Map();
  for (const track of list) {
    for (const dir of ancestors(dirOf(pathOf(track)))) {
      if (!direct.has(dir)) continue;
      const bucket = buckets.get(dir);
      if (bucket) bucket.push(track);
      else buckets.set(dir, [track]);
    }
  }

  return Array.from(buckets, ([dir, items]) => {
    const sorted = items.slice().sort(compareTracks);
    return { dir, count: sorted.length, trackIds: sorted.map((track) => track.id) };
  }).sort((a, b) => String(a.dir).localeCompare(String(b.dir)));
}
