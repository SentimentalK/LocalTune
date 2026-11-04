// Client for the playlist-resolver Worker. Spotify, NetEase and QQ Music do
// not send CORS headers, so the browser cannot call them directly; the Worker
// fetches and normalizes them server-side.

import { t } from '../../../i18n/index.js';

const SPOTIFY_PATH = /^\/(?:embed\/)?playlist\/([A-Za-z0-9]+)/;
const QQ_PATH = /^\/(?:n\/ryqq\/)?playlist\/([A-Za-z0-9]+)/;

/** Same-origin resolver endpoint, served by the deployment's own origin. */
export const DEFAULT_PROXY_URL = '/api/resolve';

const MAX_PROXY_URL = 300;
const HTTPS_PROXY_RE = /^https:\/\/\S+$/i;
const SAME_ORIGIN_PATH_RE = /^\/(?!\/)\S*$/;

/**
 * Accepts an absolute HTTPS URL or a same-origin path; anything else becomes ''.
 * '' is valid and means "use DEFAULT_PROXY_URL".
 */
export function normalizeProxyUrl(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (text === '' || text.length > MAX_PROXY_URL) return '';
  if (HTTPS_PROXY_RE.test(text) || SAME_ORIGIN_PATH_RE.test(text)) return text;
  return '';
}

function endpointOf(proxyBase) {
  const value = normalizeProxyUrl(proxyBase) || DEFAULT_PROXY_URL;
  return value.endsWith('/resolve') ? value : value.replace(/\/+$/, '') + '/resolve';
}

function toUrl(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  try {
    return new URL(text);
  } catch {
    // Bare host/path inputs are common in share sheets.
  }
  try {
    return new URL(`https://${text}`);
  } catch {
    return null;
  }
}

function neteaseId(parsed) {
  const direct = parsed.searchParams.get('id');
  if (direct && /playlist/.test(parsed.pathname)) return direct;

  if (parsed.hash.length > 1) {
    try {
      const inner = new URL(parsed.hash.slice(1), 'https://music.163.com/');
      if (!/playlist/.test(inner.pathname)) return null;
      return inner.searchParams.get('id');
    } catch {
      return null;
    }
  }
  return null;
}

/** 'spotify' | 'netease' | 'qq' | null */
export function platformOfUrl(url) {
  const parsed = toUrl(url);
  if (!parsed) return null;

  const host = parsed.hostname.toLowerCase();

  if (host === 'open.spotify.com' && SPOTIFY_PATH.test(parsed.pathname)) {
    return 'spotify';
  }

  if (host === 'music.163.com') {
    const id = neteaseId(parsed);
    return typeof id === 'string' && id.trim() !== '' ? 'netease' : null;
  }

  if (host === 'y.qq.com') {
    if (QQ_PATH.test(parsed.pathname)) return 'qq';
    if (parsed.searchParams.get('disstid') || parsed.searchParams.get('id')) return 'qq';
  }

  if (host === 'i.y.qq.com') {
    if (parsed.searchParams.get('disstid') || parsed.searchParams.get('id')) return 'qq';
  }

  return null;
}

function normalizeItem(item) {
  return {
    title: typeof item?.title === 'string' ? item.title : '',
    artist: typeof item?.artist === 'string' ? item.artist : '',
    durationMs: Number.isFinite(item?.durationMs) ? item.durationMs : 0,
    coverUrl: typeof item?.coverUrl === 'string' && item.coverUrl !== '' ? item.coverUrl : null,
  };
}

function isOk(response) {
  const status = response?.status ?? 0;
  return status >= 200 && status < 300;
}

/**
 * Resolves a non-YouTube playlist through the Worker.
 * @returns {Promise<{source:string, name:string, items:Array<{title:string,artist:string,durationMs:number,coverUrl:string|null}>, truncated:boolean}>}
 */
export async function resolveViaProxy({ url, proxyBase, fetchImpl = fetch } = {}) {
  const endpoint = endpointOf(proxyBase);
  const response = await fetchImpl(`${endpoint}?url=${encodeURIComponent(url)}`);
  if (!isOk(response)) {
    throw new Error(t('playlists.error.proxyFailed', { status: response?.status ?? 0 }));
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(t('playlists.error.proxyBadResponse'));
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.items)) {
    throw new Error(t('playlists.error.proxyBadResponse'));
  }

  return {
    source: typeof body.source === 'string' && body.source !== '' ? body.source : platformOfUrl(url),
    name: typeof body.name === 'string' ? body.name : '',
    items: body.items.map(normalizeItem),
    truncated: body.truncated === true,
  };
}
