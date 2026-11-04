/**
 * Derived view data for the UI. Pure functions over Track[].
 */

function trackNumber(track) {
  return Number.isInteger(track.trackNo) && track.trackNo > 0 ? track.trackNo : Number.MAX_SAFE_INTEGER;
}

function compareTracks(a, b) {
  const diff = trackNumber(a) - trackNumber(b);
  if (diff !== 0) return diff;
  return String(a.path ?? '').localeCompare(String(b.path ?? ''));
}

function nameOf(value) {
  return typeof value === 'string' ? value : '';
}

export function groupByAlbum(tracks = []) {
  const groups = new Map();
  for (const track of Array.from(tracks ?? [])) {
    const name = track.album ?? '';
    const artist = track.artist ?? '';
    const key = `${name}\u0000${artist}`;
    let group = groups.get(key);
    if (!group) {
      group = { name, artist, year: null, cover: null, tracks: [] };
      groups.set(key, group);
    }
    if (group.year == null && Number.isFinite(track.year)) group.year = track.year;
    if (!group.cover && track.cover) group.cover = track.cover;
    group.tracks.push(track);
  }
  const list = [...groups.values()];
  for (const group of list) group.tracks.sort(compareTracks);
  list.sort((a, b) => nameOf(a.name).localeCompare(nameOf(b.name)) || nameOf(a.artist).localeCompare(nameOf(b.artist)));
  return list;
}

export function groupByArtist(tracks = []) {
  const groups = new Map();
  for (const track of Array.from(tracks ?? [])) {
    const name = track.artist ?? '';
    let group = groups.get(name);
    if (!group) {
      group = { name, cover: null, tracks: [] };
      groups.set(name, group);
    }
    if (!group.cover && track.cover) group.cover = track.cover;
    group.tracks.push(track);
  }
  const list = [...groups.values()];
  for (const group of list) group.tracks.sort(compareTracks);
  list.sort((a, b) => nameOf(a.name).localeCompare(nameOf(b.name)));
  return list;
}

export function formatTime(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '0:00';
  const total = Math.floor(value);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}
