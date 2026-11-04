// Shared helpers: typed upstream errors, SSRF whitelist, URL detection.

export class UpstreamError extends Error {
  constructor(status) {
    super(`upstream_failed_${status}`);
    this.name = 'UpstreamError';
    this.status = status;
  }
}

export class UpstreamChangedError extends Error {
  constructor(message = 'upstream_changed') {
    super(message);
    this.name = 'UpstreamChangedError';
  }
}

// Only these hosts may be fetched. Everything else is rejected before the
// request leaves the isolate.
export const ALLOWED_HOSTS = new Set([
  'open.spotify.com',
  'music.163.com',
  'c.y.qq.com',
  'u.y.qq.com',
  'y.qq.com',
  'i.y.qq.com',
]);

/**
 * Fetch with an SSRF guard: https only, host whitelist, and the post-redirect
 * URL must still be whitelisted.
 */
export async function safeFetch(fetchImpl, url, init = {}) {
  let target;
  try {
    target = new URL(url);
  } catch {
    throw new UpstreamChangedError();
  }
  if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname)) {
    throw new UpstreamChangedError();
  }

  const response = await fetchImpl(url, { ...init, redirect: 'follow' });

  if (typeof response?.url === 'string' && response.url !== '') {
    let finalUrl;
    try {
      finalUrl = new URL(response.url);
    } catch {
      finalUrl = null;
    }
    if (!finalUrl || finalUrl.protocol !== 'https:' || !ALLOWED_HOSTS.has(finalUrl.hostname)) {
      throw new UpstreamChangedError();
    }
  }

  return response;
}

export function assertOk(response) {
  const status = response?.status ?? 0;
  if (!(status >= 200 && status < 300)) throw new UpstreamError(status);
}

const SPOTIFY_PATH = /^\/(?:embed\/)?playlist\/([A-Za-z0-9]+)/;
const QQ_PATH = /^\/(?:n\/ryqq\/)?playlist\/([A-Za-z0-9]+)/;

function hashId(parsed) {
  if (parsed.hash.length <= 1) return null;
  try {
    const inner = new URL(parsed.hash.slice(1), 'https://music.163.com/');
    if (!/playlist/.test(inner.pathname)) return null;
    return inner.searchParams.get('id');
  } catch {
    return null;
  }
}

/**
 * Canonical { platform, id } for a public playlist URL, or null.
 * Only https URLs on the supported hosts are accepted.
 */
export function parsePlaylistUrl(value) {
  if (typeof value !== 'string') return null;

  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;

  const host = parsed.hostname.toLowerCase();

  if (host === 'open.spotify.com') {
    const match = SPOTIFY_PATH.exec(parsed.pathname);
    return match ? { platform: 'spotify', id: match[1] } : null;
  }

  if (host === 'music.163.com') {
    const id = parsed.searchParams.get('id') ?? hashId(parsed);
    if (typeof id === 'string' && /^[0-9]+$/.test(id)) return { platform: 'netease', id };
    return null;
  }

  if (host === 'y.qq.com') {
    const match = QQ_PATH.exec(parsed.pathname);
    if (match) return { platform: 'qq', id: match[1] };
  }

  if (host === 'y.qq.com' || host === 'i.y.qq.com') {
    const id = parsed.searchParams.get('disstid') ?? parsed.searchParams.get('id');
    if (typeof id === 'string' && /^[0-9]+$/.test(id)) return { platform: 'qq', id };
  }

  return null;
}
