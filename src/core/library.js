/**
 * Library visibility rules. Pure functions over the source rows the store
 * exposes, so the shell, the settings view and tests agree on when a source
 * still counts.
 *
 * A source keeps its library row while it still owns indexed tracks: an
 * expired OneDrive grant loses permission but not the cached files, and those
 * tracks stay playable. Only a source with nothing indexed disappears; the
 * expiry itself is never surfaced as a prompt.
 */

export function sourceVisible(row) {
  if (!row) return false;
  if (row.permission === 'granted') return true;
  return (row.trackCount ?? 0) > 0;
}

export function visibleSources(sources) {
  return Array.from(sources ?? []).filter(sourceVisible);
}

export function libraryVisible(state) {
  return Boolean(state?.tracks?.length) || visibleSources(state?.sources).length > 0;
}
