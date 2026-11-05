/**
 * Folder tree for the library. Pure: no DOM, no storage, no imports.
 *
 * A track's directory is the POSIX substring before its last '/'. The UI walks
 * the tree one directory at a time: `subdirsOf` lists the direct children that
 * actually contain audio, `tracksDirect` lists the audio in this directory and
 * `tracksUnder` everything below it, so playing a folder includes its children.
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

/** Tracks directly inside `dir`, ordered by track number then name. */
export function tracksDirect(tracks = [], dir = '') {
  return Array.from(tracks ?? [])
    .filter((track) => dirOf(pathOf(track)) === dir)
    .sort(compareTracks);
}

/** Tracks anywhere below `dir` (its subtree), ordered by track number then name. */
export function tracksUnder(tracks = [], dir = '') {
  const prefix = dir === '' ? null : `${dir}/`;
  return Array.from(tracks ?? [])
    .filter((track) => prefix === null || pathOf(track).startsWith(prefix))
    .sort(compareTracks);
}

/**
 * Direct subdirectories of `dir` that contain at least one track, each with
 * its recursive track count. Sorted naturally by directory name.
 */
export function subdirsOf(tracks = [], dir = '') {
  const prefix = dir === '' ? '' : `${dir}/`;
  const names = new Set();
  for (const track of Array.from(tracks ?? [])) {
    const path = pathOf(track);
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) continue;
    names.add(prefix + rest.slice(0, slash));
  }

  const list = [];
  for (const sub of names) {
    const count = tracksUnder(tracks, sub).length;
    if (count > 0) list.push({ dir: sub, name: baseOf(sub), count });
  }
  return list.sort((a, b) => collator.compare(a.name, b.name));
}
