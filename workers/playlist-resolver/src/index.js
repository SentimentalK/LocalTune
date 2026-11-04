// Playlist resolver Worker: fetches public playlist metadata from Spotify,
// NetEase Cloud Music and QQ Music, normalizes it, and replies with CORS
// headers for the app origins only.
//
// Privacy: request URLs, titles and artists are never logged or persisted.
// Only { count, status, ms } is logged.

import * as spotify from './providers/spotify.js';
import * as netease from './providers/netease.js';
import * as qq from './providers/qq.js';
import {
  UpstreamChangedError,
  UpstreamError,
  parsePlaylistUrl,
} from './providers/shared.js';

const ALLOWED_ORIGINS = new Set([
  'https://tune.mainstayx.com',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
]);

const PROVIDERS = {
  spotify: spotify.resolve,
  netease: netease.resolve,
  qq: qq.resolve,
};

const DEFAULT_RATE_LIMIT = { windowMs: 60_000, max: 30 };
const RETRY_AFTER_SECONDS = 60;
const CACHE_CONTROL = 'public, max-age=600';

function corsHeaders(origin) {
  const headers = new Headers();
  if (origin) {
    headers.set('access-control-allow-origin', origin);
    headers.set('vary', 'Origin');
  }
  return headers;
}

function jsonResponse(body, status, origin, extraHeaders = {}) {
  const headers = corsHeaders(origin);
  headers.set('content-type', 'application/json; charset=utf-8');
  for (const [name, value] of Object.entries(extraHeaders)) {
    headers.set(name, value);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function withCors(response, origin) {
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', origin);
  headers.set('vary', 'Origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function defaultCache() {
  if (typeof caches === 'undefined') return null;
  return caches.default ?? null;
}

function normalizeItems(items) {
  return items.map((item) => ({
    title: typeof item?.title === 'string' ? item.title : '',
    artist: typeof item?.artist === 'string' ? item.artist : '',
    durationMs: Number.isFinite(item?.durationMs) ? item.durationMs : 0,
    coverUrl: typeof item?.coverUrl === 'string' && item.coverUrl !== '' ? item.coverUrl : null,
  }));
}

function prune(hits, cutoff) {
  for (const [key, stamps] of hits) {
    const live = stamps.filter((stamp) => stamp > cutoff);
    if (live.length === 0) hits.delete(key);
    else hits.set(key, live);
  }
}

/**
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   cache?: { match(key: string): Promise<Response|undefined>, put(key: string, response: Response): Promise<void> }|null,
 *   rateLimit?: { windowMs?: number, max?: number },
 * }} options
 */
export function createHandler({ fetchImpl = fetch, now = Date.now, cache = defaultCache(), rateLimit } = {}) {
  const windowMs = rateLimit?.windowMs ?? DEFAULT_RATE_LIMIT.windowMs;
  const max = rateLimit?.max ?? DEFAULT_RATE_LIMIT.max;
  const hits = new Map();
  let count = 0;

  async function resolveRequest(request, origin) {
    const url = new URL(request.url);
    const target = url.searchParams.get('url');
    const detected = parsePlaylistUrl(target);
    if (!detected) {
      return jsonResponse({ error: 'unsupported' }, 400, origin);
    }

    const current = now();
    const ip = request.headers.get('cf-connecting-ip') ?? 'anonymous';
    const cutoff = current - windowMs;
    const stamps = (hits.get(ip) ?? []).filter((stamp) => stamp > cutoff);
    if (stamps.length >= max) {
      hits.set(ip, stamps);
      return jsonResponse({ error: 'rate_limited' }, 429, origin, {
        'retry-after': String(RETRY_AFTER_SECONDS),
      });
    }
    stamps.push(current);
    hits.set(ip, stamps);
    if (hits.size > 512) prune(hits, cutoff);

    const { platform, id } = detected;
    // Cache key is canonical: platform + id only, never the raw query string.
    const cacheKey = `https://playlist-resolver.internal/${platform}/${id}`;

    if (cache) {
      try {
        const hit = await cache.match(cacheKey);
        if (hit) return withCors(hit, origin);
      } catch {
        // A cache failure must never fail the request.
      }
    }

    let result;
    try {
      result = await PROVIDERS[platform](id, { fetchImpl });
    } catch (error) {
      if (error instanceof UpstreamChangedError) {
        return jsonResponse({ error: 'upstream_changed' }, 502, origin);
      }
      if (error instanceof UpstreamError) {
        return jsonResponse({ error: 'upstream_failed', status: error.status }, 502, origin);
      }
      return jsonResponse({ error: 'upstream_failed' }, 502, origin);
    }

    const items = normalizeItems(Array.isArray(result?.items) ? result.items : []);
    if (items.length === 0) {
      // Never disguise an upstream structure change as an empty playlist.
      return jsonResponse({ error: 'upstream_changed' }, 502, origin);
    }

    const payload = {
      source: platform,
      name: typeof result?.name === 'string' ? result.name : '',
      items,
      truncated: result?.truncated === true,
    };

    if (cache) {
      try {
        const stored = new Response(JSON.stringify(payload), {
          headers: {
            'cache-control': CACHE_CONTROL,
            'content-type': 'application/json; charset=utf-8',
          },
        });
        await cache.put(cacheKey, stored);
      } catch {
        // Best effort.
      }
    }

    return jsonResponse(payload, 200, origin, { 'cache-control': CACHE_CONTROL });
  }

  return async function handle(request) {
    const started = now();
    const origin = request.headers.get('origin');
    const allowedOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : null;
    const path = new URL(request.url).pathname;

    let response;

    if (request.method === 'OPTIONS') {
      if (origin && !allowedOrigin) {
        response = jsonResponse({ error: 'origin_not_allowed' }, 403, null);
      } else {
        const headers = corsHeaders(allowedOrigin);
        headers.set('access-control-allow-methods', 'GET,OPTIONS');
        headers.set('access-control-max-age', '86400');
        response = new Response(null, { status: 204, headers });
      }
    } else if (path === '/healthz') {
      response = jsonResponse({ ok: true }, 200, allowedOrigin);
    } else if (path === '/resolve') {
      if (request.method !== 'GET') {
        response = jsonResponse({ error: 'method_not_allowed' }, 405, allowedOrigin);
      } else if (origin && !allowedOrigin) {
        response = jsonResponse({ error: 'origin_not_allowed' }, 403, null);
      } else {
        response = await resolveRequest(request, allowedOrigin);
      }
    } else {
      response = jsonResponse({ error: 'not_found' }, 404, allowedOrigin);
    }

    count += 1;
    console.log({ count, status: response.status, ms: now() - started });
    return response;
  };
}

export default {
  fetch: createHandler(),
};
