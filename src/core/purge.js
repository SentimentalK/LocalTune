/**
 * Drop one source's index rows and its cached audio. Order is index → cache so
 * a partial failure can never leave cache rows that point at deleted tracks.
 */
export async function purgeSourceRows({ source, tracks = [], deleteTracks, cache, onRemoved } = {}) {
  const removedIds = (tracks ?? []).filter((track) => track?.source === source).map((track) => track.id);
  if (removedIds.length && typeof deleteTracks === 'function') await deleteTracks(removedIds);
  if (cache && typeof cache.removeBySource === 'function') await cache.removeBySource(source).catch(() => 0);
  onRemoved?.(removedIds);
  return removedIds;
}
