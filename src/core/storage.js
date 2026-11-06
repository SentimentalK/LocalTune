/**
 * Storage accounting for the settings view. Pure logic: Cache Storage is
 * injected (or read from the global) so the byte calculations can be tested
 * without a browser. Nothing here touches the library or the audio player.
 */

const UNITS = ['KB', 'MB', 'GB'];
const AUDIO_PATH = /\.(mp3|m4a|flac|ogg|oga|wav|webm)$/i;

const encoder = new TextEncoder();

/** Human-readable byte count: 0 B, 1023 B, 1 KB, 1.5 KB, 1 MB. */
export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${Math.round(value)} B`;

  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < UNITS.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  const rounded = Math.round(scaled * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} ${UNITS[unit]}`;
}

/**
 * Approximate on-disk footprint of the index:
 * - indexBytes: each track record without `cover`, JSON-encoded as UTF-8;
 * - coverBytes: the summed `coverSize` of rows whose cover lives in the
 *   separate covers store.
 */
export async function estimateLibrary(tracks) {
  const list = Array.from(tracks ?? []);
  let indexBytes = 0;
  let coverBytes = 0;

  for (const track of list) {
    const { cover, ...rest } = track ?? {};
    indexBytes += encoder.encode(JSON.stringify(rest)).length;
    if (Number.isFinite(track?.coverSize) && track.coverSize > 0) coverBytes += track.coverSize;
  }

  return { indexBytes, coverBytes };
}

function requestUrl(request) {
  if (typeof request === 'string') return request;
  if (request instanceof URL) return request.href;
  return request?.url ?? String(request ?? '');
}

function isAudioEntry(request, response) {
  try {
    const url = new URL(requestUrl(request), globalThis.location?.href ?? 'http://localhost/');
    const origin = globalThis.location?.origin;
    if (origin && url.origin !== origin) return false;
    if (AUDIO_PATH.test(url.pathname)) return true;
    const type = response?.headers?.get?.('content-type') ?? '';
    return type.toLowerCase().startsWith('audio/');
  } catch {
    return false;
  }
}

/** Every matching same-origin cache entry; failures on one entry are skipped. */
async function findAudioEntries(cachesImpl) {
  const storage = cachesImpl ?? globalThis.caches;
  if (!storage || typeof storage.keys !== 'function' || typeof storage.open !== 'function') {
    return [];
  }

  const found = [];
  let names = [];
  try {
    names = await storage.keys();
  } catch {
    return found;
  }

  for (const name of names) {
    let cache = null;
    try {
      cache = await storage.open(name);
    } catch {
      continue;
    }
    let requests = [];
    try {
      requests = await cache.keys();
    } catch {
      continue;
    }
    for (const request of requests) {
      try {
        const response = await cache.match(request);
        if (!response || !isAudioEntry(request, response)) continue;
        found.push({ cache, request, response });
      } catch {
        // One unreadable entry must not hide the rest of the cache.
      }
    }
  }

  return found;
}

/** Bytes held by cached audio responses (extension or `audio/*` content type). */
export async function estimateAudioCache(cachesImpl = globalThis.caches) {
  const entries = await findAudioEntries(cachesImpl);
  let total = 0;
  for (const { response } of entries) {
    try {
      const blob = await response.blob();
      if (Number.isFinite(blob?.size)) total += blob.size;
    } catch {
      // Size unknown: count nothing, still report the entries that worked.
    }
  }
  return total;
}

/** Delete cached audio responses; returns the bytes they occupied. */
export async function clearAudioCache(cachesImpl = globalThis.caches) {
  const entries = await findAudioEntries(cachesImpl);
  let total = 0;

  for (const { response } of entries) {
    try {
      const blob = await response.blob();
      if (Number.isFinite(blob?.size)) total += blob.size;
    } catch {
      // Keep going: deletion is still worth attempting.
    }
  }

  for (const { cache, request } of entries) {
    try {
      await cache.delete(request);
    } catch {
      // Another tab may have removed it already.
    }
  }

  return total;
}
