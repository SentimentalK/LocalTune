/**
 * Derived view data for the UI. Pure functions over Track[].
 */

export function formatTime(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '0:00';
  const total = Math.floor(value);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

/** Row duration: an unknown duration stays visibly unknown. */
export function formatDuration(seconds) {
  const value = Number(seconds);
  return Number.isFinite(value) && value > 0 ? formatTime(value) : '--:--';
}
